from __future__ import annotations

from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import gcd
import os
from pathlib import Path
import random
import re
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .models import Block, BlockOccurrence, BlockSubjectEntry, ScheduleRequest, ScheduleResponse, ScheduledItem, Subject, Timeslot


MAX_WEEKLY_WORK_MINUTES_100_PERCENT = 29 * 60
PREFERRED_AVOID_WEIGHT = 20
DAY_IMBALANCE_WEIGHT = 1
BOUNDARY_SLOT_WEIGHT = 1
BOUNDARY_REPEAT_EXCESS_WEIGHT = 2
TEACHER_PRESENCE_EXCESS_WEIGHT = 5
TEACHER_WORKLOAD_EXCESS_WEIGHT = 10
FELLESFAG_SAME_DAY_PENALTY_WEIGHT = 3
NORSK_VG3_NO_DOUBLE90_PENALTY_WEIGHT = 12
SOLVER_LOG_PATH = Path(__file__).resolve().parents[1] / "solver_last_run.log"
DAY_ORDER_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


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
    timeslots_by_id: Dict[str, Timeslot],
) -> Set[str]:
    # Direct timeslot restriction has highest priority.
    if subject.allowed_timeslots:
        allowed = set(subject.allowed_timeslots) & all_timeslot_ids
    elif subject.allowed_block_ids:
        block_slots: Set[str] = set()
        for block_id in subject.allowed_block_ids:
            block_slots |= block_to_timeslots.get(block_id, set())
        allowed = block_slots & all_timeslot_ids
    else:
        allowed = set(all_timeslot_ids)

    filtered: Set[str] = set()
    subject_class_ids = set(subject.class_ids or [])
    for timeslot_id in allowed:
        timeslot = timeslots_by_id.get(timeslot_id)
        if not timeslot:
            continue
        if not getattr(timeslot, "excluded_from_generation", False):
            filtered.add(timeslot_id)
            continue

        allowed_class_ids = set(getattr(timeslot, "generation_allowed_class_ids", []) or [])
        if subject_class_ids and subject_class_ids.issubset(allowed_class_ids):
            filtered.add(timeslot_id)

    return filtered


def _subject_teacher_ids(subject: Subject) -> List[str]:
    # Support both legacy teacher_id and new teacher_ids.
    candidates: List[str] = []
    if getattr(subject, "teacher_id", ""):
        candidates.append(subject.teacher_id)
    candidates.extend(getattr(subject, "teacher_ids", []) or [])
    return list(dict.fromkeys([teacher_id for teacher_id in candidates if teacher_id]))


def _subject_link_group_id(subject: Subject) -> str:
    raw_value = getattr(subject, "link_group_id", "")
    if not isinstance(raw_value, str):
        return ""
    return raw_value.strip()


def _block_entry_teacher_ids(entry: BlockSubjectEntry) -> List[str]:
    candidates: List[str] = []
    if getattr(entry, "teacher_id", ""):
        candidates.append(entry.teacher_id)
    candidates.extend(getattr(entry, "teacher_ids", []) or [])
    return list(dict.fromkeys([teacher_id for teacher_id in candidates if teacher_id]))


def _compute_allowed_weeks(
    subject: Subject,
    alternating_weeks_enabled: bool,
    blocks_by_id: Dict[str, Block],
    linked_block_ids: Dict[str, Set[str]],
) -> Set[str]:
    if not alternating_weeks_enabled:
        return {"base"}

    # Force-placed subjects are expected in both A/B weeks unless generation
    # is non-alternating. This prevents odd/even balancing from dropping one week.
    if getattr(subject, "force_place", False) and (getattr(subject, "force_timeslot_id", "") or "").strip():
        return {"A", "B"}

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
    Sports-only subjects (listed in any sports_hall.allowed_subject_ids) are
    restricted to sports hall rooms exclusively.
    """
    sports_halls = getattr(data, "sports_halls", []) or []
    # Build a mapping of room-like objects from sports halls so the solver can
    # assign them just like regular rooms.
    sports_hall_ids: Set[str] = {sh.id for sh in sports_halls}
    sports_only_subject_ids: Set[str] = {
        sid for sh in sports_halls for sid in sh.allowed_subject_ids
    }
    # Combine regular rooms and sports halls into a single pool for the solver.
    all_rooms = list(data.rooms) + [
        type("_SHRoom", (), {"id": sh.id, "name": sh.name, "prioritize_for_preferred_subjects": False})()
        for sh in sports_halls
    ]

    if not all_rooms:
        return schedule_items

    rooms_by_id = {r.id: r for r in all_rooms}
    room_id_by_name_normalized = {
        str(getattr(room, "name", "") or "").strip().lower(): room.id
        for room in all_rooms
        if str(getattr(room, "name", "") or "").strip()
    }
    room_ids_ordered = list(rooms_by_id.keys())
    room_order_index = {room_id: idx for idx, room_id in enumerate(room_ids_ordered)}
    prioritized_rooms = {
        room.id
        for room in all_rooms
        if getattr(room, "prioritize_for_preferred_subjects", False)
    }
    teachers_by_id = {teacher.id: teacher for teacher in data.teachers}
    result_items: List[ScheduledItem] = []

    items_by_slot: Dict[Tuple[str, str | None], List[ScheduledItem]] = defaultdict(list)
    for item in schedule_items:
        items_by_slot[(item.timeslot_id, item.week_type)].append(item)

    remaining_by_subject_week: Dict[Tuple[str, str], int] = defaultdict(int)
    for item in schedule_items:
        remaining_by_subject_week[(item.subject_id, item.week_type or "base")] += 1

    once_mode_satisfied: Dict[Tuple[str, str, str], bool] = defaultdict(bool)
    once_preferred_grants: Dict[Tuple[str, str, str], int] = defaultdict(int)
    room_usage: Dict[Tuple[str, str | None], Set[str]] = defaultdict(set)
    subject_room_usage_any: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    subject_room_usage_by_week: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    subject_slot_room_by_week: Dict[Tuple[str, str, str], str] = {}

    def _opposite_week(week_key: str) -> str | None:
        if week_key == "A":
            return "B"
        if week_key == "B":
            return "A"
        return None

    def _pick_with_consistency(
        candidate_room_ids: List[str],
        subject_id: str,
        week_key: str,
        timeslot_id: str | None = None,
    ) -> str | None:
        if not candidate_room_ids:
            return None
        opposite_week = _opposite_week(week_key)
        mirrored_room = (
            subject_slot_room_by_week.get((subject_id, timeslot_id, opposite_week))
            if timeslot_id and opposite_week
            else None
        )

        # Prefer the same room across all sessions first, then within week,
        # and strongly prefer matching the opposite week's room in the same slot.
        def _score(room_id: str) -> Tuple[int, int, int, int]:
            mirror_penalty = 0 if mirrored_room and room_id == mirrored_room else 1
            any_count = subject_room_usage_any[subject_id].get(room_id, 0)
            week_count = subject_room_usage_by_week[(subject_id, week_key)].get(room_id, 0)
            order_idx = room_order_index.get(room_id, len(room_order_index))
            return (mirror_penalty, -any_count, -week_count, order_idx)

        return min(candidate_room_ids, key=_score)

    def _item_teacher_ids(item: ScheduledItem) -> List[str]:
        teacher_ids: List[str] = []
        if item.teacher_id:
            teacher_ids.append(item.teacher_id)
        teacher_ids.extend(item.teacher_ids or [])
        return list(dict.fromkeys([teacher_id for teacher_id in teacher_ids if teacher_id]))

    def _room_policy_for_item(item: ScheduledItem, subject: Subject | None) -> Tuple[List[str], str]:
        def _resolve_preferred_room_tokens(tokens: List[str] | None) -> List[str]:
            resolved: List[str] = []
            for token in (tokens or []):
                raw = str(token or "").strip()
                if not raw:
                    continue
                if raw in rooms_by_id:
                    resolved.append(raw)
                    continue
                mapped_id = room_id_by_name_normalized.get(raw.lower())
                if mapped_id:
                    resolved.append(mapped_id)
            return list(dict.fromkeys(resolved))

        subject_preferred_rooms = _resolve_preferred_room_tokens(
            getattr(subject, "preferred_room_ids", []) or []
        )
        if subject_preferred_rooms:
            return (
                subject_preferred_rooms,
                str(getattr(subject, "room_requirement_mode", "always") or "always"),
            )

        for teacher_id in _item_teacher_ids(item):
            teacher = teachers_by_id.get(teacher_id)
            if not teacher:
                continue
            teacher_preferred_rooms = _resolve_preferred_room_tokens(
                getattr(teacher, "preferred_room_ids", []) or []
            )
            if teacher_preferred_rooms:
                return (
                    teacher_preferred_rooms,
                    str(getattr(teacher, "room_requirement_mode", "always") or "always"),
                )

        return ([], "always")

    def _once_scope_keys_for_item(
        item: ScheduledItem,
        subject: Subject | None,
        week_key: str,
    ) -> List[Tuple[str, str, str]]:
        # Fellesfag should satisfy once_per_week per class, not per subject.
        if subject and subject.subject_type == "fellesfag" and item.class_ids:
            class_ids = sorted({class_id for class_id in item.class_ids if class_id})
            if class_ids:
                return [(item.subject_id, week_key, class_id) for class_id in class_ids]
        return [(item.subject_id, week_key, "*")]

    ordered_slot_keys = sorted(items_by_slot.keys(), key=lambda key: (key[1] or "base", key[0]))

    for (timeslot_id, week_type) in ordered_slot_keys:
        items = items_by_slot[(timeslot_id, week_type)]

        def item_priority(item: ScheduledItem) -> Tuple[int, int, str]:
            subject = subjects_by_id.get(item.subject_id)
            preferred_rooms, mode = _room_policy_for_item(item, subject)
            if item.subject_id in sports_only_subject_ids:
                preferred_rooms = [room_id for room_id in preferred_rooms if room_id in sports_hall_ids]
            else:
                preferred_rooms = [room_id for room_id in preferred_rooms if room_id not in sports_hall_ids]
            week_key = item.week_type or "base"
            once_scope_keys = _once_scope_keys_for_item(item, subject, week_key)
            once_pending = any(not once_mode_satisfied[key] for key in once_scope_keys)
            prioritized_preferred_rooms = [room_id for room_id in preferred_rooms if room_id in prioritized_rooms]
            once_grant_count = sum(
                once_preferred_grants[(room_id, week_key, item.subject_id)]
                for room_id in prioritized_preferred_rooms
            )

            has_base_room = False
            if subject and subject.subject_type == "fellesfag" and item.class_ids:
                has_base_room = item.class_ids[0] in class_to_base_room

            # Boost base-room subjects so class base-room stability wins more often.
            if has_base_room:
                return (0, once_grant_count, item.subject_id)

            if preferred_rooms and mode == "once_per_week" and once_pending:
                # Strongly prioritize guaranteeing at least one preferred-room placement.
                return (1, once_grant_count, item.subject_id)
            if preferred_rooms and mode == "always":
                return (2, once_grant_count, item.subject_id)
            if preferred_rooms and mode == "once_per_week":
                # After the once-per-week requirement is satisfied, deprioritize
                # further preferred-room claims so base rooms can be used.
                return (4, once_grant_count, item.subject_id)
            return (3, once_grant_count, item.subject_id)

        sorted_items = sorted(items, key=item_priority)

        for item in sorted_items:
            subject = subjects_by_id.get(item.subject_id)
            week_key = item.week_type or "base"
            subject_week_key = (item.subject_id, week_key)
            used_rooms = room_usage[(timeslot_id, week_type)]
            is_sports_only = item.subject_id in sports_only_subject_ids

            preferred_rooms, mode = _room_policy_for_item(item, subject)
            if is_sports_only:
                preferred_rooms = [room_id for room_id in preferred_rooms if room_id in sports_hall_ids]
            else:
                preferred_rooms = [room_id for room_id in preferred_rooms if room_id not in sports_hall_ids]

            assigned_room_id: str | None = None
            available_preferred = [room_id for room_id in preferred_rooms if room_id not in used_rooms]
            available_any = [room_id for room_id in room_ids_ordered if room_id not in used_rooms]
            # Sports-only subjects must use sports hall rooms exclusively; all other
            # subjects must NOT use sports hall rooms.
            if is_sports_only:
                available_any = [room_id for room_id in available_any if room_id in sports_hall_ids]
            else:
                available_any = [room_id for room_id in available_any if room_id not in sports_hall_ids]
            available_non_prioritized = [room_id for room_id in available_any if room_id not in prioritized_rooms]
            available_prioritized = [room_id for room_id in available_any if room_id in prioritized_rooms]
            available_non_preferred_non_prioritized = [
                room_id for room_id in available_non_prioritized if room_id not in preferred_rooms
            ]
            available_non_preferred_prioritized = [
                room_id for room_id in available_prioritized if room_id not in preferred_rooms
            ]
            base_room_id: str | None = None
            if not is_sports_only and subject and subject.subject_type == "fellesfag" and item.class_ids:
                first_class_id = item.class_ids[0]
                base_room_id = class_to_base_room.get(first_class_id)

            if preferred_rooms and mode == "always":
                if available_preferred:
                    assigned_room_id = _pick_with_consistency(
                        available_preferred,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_non_preferred_non_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_preferred_non_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_non_preferred_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_preferred_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
            elif preferred_rooms and mode == "once_per_week":
                once_scope_keys = _once_scope_keys_for_item(item, subject, week_key)
                once_pending = any(not once_mode_satisfied[key] for key in once_scope_keys)
                if once_pending and available_preferred:
                    assigned_room_id = _pick_with_consistency(
                        available_preferred,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                    for scope_key in once_scope_keys:
                        once_mode_satisfied[scope_key] = True
                elif base_room_id and base_room_id not in used_rooms:
                    assigned_room_id = base_room_id
                elif available_non_preferred_non_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_preferred_non_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_non_preferred_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_preferred_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_preferred:
                    assigned_room_id = _pick_with_consistency(
                        available_preferred,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_non_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                elif available_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
            else:
                if base_room_id and base_room_id not in used_rooms:
                    assigned_room_id = base_room_id
                if not assigned_room_id and available_non_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_non_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )
                if not assigned_room_id and available_prioritized:
                    assigned_room_id = _pick_with_consistency(
                        available_prioritized,
                        item.subject_id,
                        week_key,
                        item.timeslot_id,
                    )

            if assigned_room_id:
                used_rooms.add(assigned_room_id)
                subject_room_usage_any[item.subject_id][assigned_room_id] += 1
                subject_room_usage_by_week[(item.subject_id, week_key)][assigned_room_id] += 1
                subject_slot_room_by_week[(item.subject_id, item.timeslot_id, week_key)] = assigned_room_id
                if assigned_room_id in preferred_rooms and mode == "once_per_week":
                    once_scope_keys = _once_scope_keys_for_item(item, subject, week_key)
                    once_preferred_grants[(assigned_room_id, week_key, item.subject_id)] += 1
                    for scope_key in once_scope_keys:
                        once_mode_satisfied[scope_key] = True

            remaining_by_subject_week[subject_week_key] = max(0, remaining_by_subject_week[subject_week_key] - 1)

            result_items.append(
                ScheduledItem(
                    subject_id=item.subject_id,
                    subject_name=item.subject_name,
                    teacher_id=item.teacher_id,
                    teacher_ids=item.teacher_ids,
                    class_ids=item.class_ids,
                    timeslot_id=item.timeslot_id,
                    day=item.day,
                    period=item.period,
                    start_time=item.start_time,
                    end_time=item.end_time,
                    week_type=item.week_type,
                    room_id=assigned_room_id,
                )
            )

    # Best-effort pass for once_per_week subjects in alternating schedules:
    # ensure each week (A and B) gets at least one preferred-room placement
    # when this can be achieved by reusing a free preferred room or a safe
    # same-slot room swap.
    item_preferred_rooms: Dict[int, Set[str]] = {}
    item_pref_modes: Dict[int, str] = {}
    once_subject_ids: Set[str] = set()
    for idx, item in enumerate(result_items):
        subject = subjects_by_id.get(item.subject_id)
        subject = subjects_by_id.get(item.subject_id)
        preferred_room_list, pref_mode = _room_policy_for_item(item, subject)
        preferred_room_set = set(preferred_room_list)
        item_preferred_rooms[idx] = preferred_room_set
        item_pref_modes[idx] = pref_mode
        # The pass below is subject-level; keep it for non-fellesfag only.
        # Fellesfag once_per_week is handled per class in the main assignment pass.
        if pref_mode == "once_per_week" and preferred_room_set and not (subject and subject.subject_type == "fellesfag"):
            once_subject_ids.add(item.subject_id)

    items_by_slot_index: Dict[Tuple[str, str | None], List[int]] = defaultdict(list)
    for idx, item in enumerate(result_items):
        items_by_slot_index[(item.timeslot_id, item.week_type)].append(idx)

    def _enforced_week_keys(item: ScheduledItem) -> Tuple[str, ...]:
        # In alternating mode, a both-week item (week_type=None) satisfies both A and B.
        if data.alternating_weeks_enabled:
            if item.week_type in {"A", "B"}:
                return (item.week_type,)
            if item.week_type is None:
                return ("A", "B")
        return ((item.week_type or "base"),)

    subject_week_indexes: Dict[Tuple[str, str], List[int]] = defaultdict(list)
    for idx, item in enumerate(result_items):
        for week_key in _enforced_week_keys(item):
            subject_week_indexes[(item.subject_id, week_key)].append(idx)

    preferred_count_by_subject_week: Dict[Tuple[str, str], int] = defaultdict(int)
    for idx, item in enumerate(result_items):
        preferred_set = item_preferred_rooms.get(idx, set())
        if item.room_id and item.room_id in preferred_set:
            for week_key in _enforced_week_keys(item):
                preferred_count_by_subject_week[(item.subject_id, week_key)] += 1

    def _set_item_room(index: int, room_id: str | None) -> None:
        item = result_items[index]
        result_items[index] = ScheduledItem(
            subject_id=item.subject_id,
            subject_name=item.subject_name,
            teacher_id=item.teacher_id,
            teacher_ids=item.teacher_ids,
            class_ids=item.class_ids,
            timeslot_id=item.timeslot_id,
            day=item.day,
            period=item.period,
            start_time=item.start_time,
            end_time=item.end_time,
            week_type=item.week_type,
            room_id=room_id,
        )

    for (subject_id, week_key), indexes in list(subject_week_indexes.items()):
        if subject_id not in once_subject_ids:
            continue
        if week_key not in ({"A", "B"} if data.alternating_weeks_enabled else {"base"}):
            continue
        if preferred_count_by_subject_week[(subject_id, week_key)] > 0:
            continue

        if not any(item_preferred_rooms.get(idx, set()) for idx in indexes):
            continue

        satisfied = False
        for idx in indexes:
            item = result_items[idx]
            preferred_set = item_preferred_rooms.get(idx, set())
            if not preferred_set:
                continue
            slot_key = (item.timeslot_id, item.week_type)
            slot_indexes = items_by_slot_index.get(slot_key, [])
            used_rooms = {
                result_items[slot_idx].room_id
                for slot_idx in slot_indexes
                if result_items[slot_idx].room_id
            }

            free_preferred = [room_id for room_id in preferred_set if room_id not in used_rooms]
            if free_preferred:
                chosen_room = _pick_with_consistency(free_preferred, subject_id, week_key)
                if chosen_room:
                    _set_item_room(idx, chosen_room)
                    subject_slot_room_by_week[(subject_id, item.timeslot_id, week_key)] = chosen_room
                    preferred_count_by_subject_week[(subject_id, week_key)] += 1
                    satisfied = True
                    break

            for preferred_room_id in preferred_set:
                occupant_indexes = [
                    slot_idx
                    for slot_idx in slot_indexes
                    if result_items[slot_idx].room_id == preferred_room_id
                ]
                if not occupant_indexes:
                    continue

                occupant_idx = occupant_indexes[0]
                if occupant_idx == idx:
                    preferred_count_by_subject_week[(subject_id, week_key)] += 1
                    satisfied = True
                    break

                occupant_item = result_items[occupant_idx]
                occupant_week_keys = _enforced_week_keys(occupant_item)
                occupant_mode = item_pref_modes.get(occupant_idx, "always")
                occupant_preferred_set = item_preferred_rooms.get(occupant_idx, set())

                used_without_occupant = {
                    result_items[slot_idx].room_id
                    for slot_idx in slot_indexes
                    if slot_idx != occupant_idx and result_items[slot_idx].room_id
                }
                available_for_occupant = [
                    room_id
                    for room_id in room_ids_ordered
                    if room_id not in used_without_occupant and room_id != preferred_room_id
                ]
                if not available_for_occupant:
                    continue

                if occupant_mode == "always" and occupant_preferred_set:
                    available_for_occupant = [
                        room_id for room_id in available_for_occupant if room_id in occupant_preferred_set
                    ]
                    if not available_for_occupant:
                        continue

                if (
                    occupant_mode == "once_per_week"
                    and occupant_preferred_set
                    and preferred_room_id in occupant_preferred_set
                    and any(
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] <= 1
                        for wk in occupant_week_keys
                    )
                ):
                    available_for_occupant = [
                        room_id for room_id in available_for_occupant if room_id in occupant_preferred_set
                    ]
                    if not available_for_occupant:
                        continue

                swap_room = _pick_with_consistency(
                    available_for_occupant,
                    occupant_item.subject_id,
                    occupant_item.week_type or "base",
                )
                if not swap_room:
                    continue

                _set_item_room(occupant_idx, swap_room)
                _set_item_room(idx, preferred_room_id)
                occupant_week_key = occupant_item.week_type or "base"
                subject_slot_room_by_week[(occupant_item.subject_id, occupant_item.timeslot_id, occupant_week_key)] = swap_room
                subject_slot_room_by_week[(subject_id, item.timeslot_id, week_key)] = preferred_room_id

                if preferred_room_id in occupant_preferred_set and swap_room not in occupant_preferred_set:
                    for wk in occupant_week_keys:
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] -= 1
                elif preferred_room_id not in occupant_preferred_set and swap_room in occupant_preferred_set:
                    for wk in occupant_week_keys:
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] += 1

                for wk in _enforced_week_keys(result_items[idx]):
                    preferred_count_by_subject_week[(subject_id, wk)] += 1
                satisfied = True
                break

            if satisfied:
                break

    # Mirrored best-effort pass for alternating schedules:
    # for A/B pairs of the same subject in the same slot, if one week uses a
    # preferred room and the other does not, try to mirror preferred-room usage
    # on the opposite week as well.
    if data.alternating_weeks_enabled:
        subject_slot_week_index: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(dict)
        for idx, item in enumerate(result_items):
            week_label = item.week_type or "base"
            if week_label in {"A", "B"}:
                subject_slot_week_index[(item.subject_id, item.timeslot_id)][week_label] = idx

        for (subject_id, _timeslot_id), week_map in subject_slot_week_index.items():
            if subject_id not in once_subject_ids:
                continue
            if "A" not in week_map or "B" not in week_map:
                continue

            idx_a = week_map["A"]
            idx_b = week_map["B"]
            room_a = result_items[idx_a].room_id
            room_b = result_items[idx_b].room_id
            preferred_set_a = item_preferred_rooms.get(idx_a, set())
            preferred_set_b = item_preferred_rooms.get(idx_b, set())
            has_pref_a = bool(room_a and room_a in preferred_set_a)
            has_pref_b = bool(room_b and room_b in preferred_set_b)

            # Only act when one week has preferred room and the other does not.
            if has_pref_a == has_pref_b:
                continue

            source_idx = idx_a if has_pref_a else idx_b
            target_idx = idx_b if has_pref_a else idx_a
            target_item = result_items[target_idx]
            target_week_key = target_item.week_type or "base"
            target_preferred_set = item_preferred_rooms.get(target_idx, set())
            if not target_preferred_set:
                continue

            preferred_order: List[str] = []
            source_room = result_items[source_idx].room_id
            if source_room and source_room in target_preferred_set:
                preferred_order.append(source_room)
            preferred_order.extend([room_id for room_id in target_preferred_set if room_id not in preferred_order])

            slot_key = (target_item.timeslot_id, target_item.week_type)
            slot_indexes = items_by_slot_index.get(slot_key, [])
            used_rooms = {
                result_items[slot_idx].room_id
                for slot_idx in slot_indexes
                if result_items[slot_idx].room_id
            }

            mirrored = False

            free_preferred = [room_id for room_id in preferred_order if room_id not in used_rooms]
            if free_preferred:
                chosen_room = _pick_with_consistency(free_preferred, subject_id, target_week_key)
                if chosen_room:
                    _set_item_room(target_idx, chosen_room)
                    subject_slot_room_by_week[(subject_id, target_item.timeslot_id, target_week_key)] = chosen_room
                    for wk in _enforced_week_keys(result_items[target_idx]):
                        preferred_count_by_subject_week[(subject_id, wk)] += 1
                    mirrored = True

            if mirrored:
                continue

            for preferred_room_id in preferred_order:
                occupant_indexes = [
                    slot_idx
                    for slot_idx in slot_indexes
                    if result_items[slot_idx].room_id == preferred_room_id
                ]
                if not occupant_indexes:
                    continue

                occupant_idx = occupant_indexes[0]
                if occupant_idx == target_idx:
                    for wk in _enforced_week_keys(result_items[target_idx]):
                        preferred_count_by_subject_week[(subject_id, wk)] += 1
                    mirrored = True
                    break

                occupant_item = result_items[occupant_idx]
                occupant_week_keys = _enforced_week_keys(occupant_item)
                occupant_mode = item_pref_modes.get(occupant_idx, "always")
                occupant_preferred_set = item_preferred_rooms.get(occupant_idx, set())

                used_without_occupant = {
                    result_items[slot_idx].room_id
                    for slot_idx in slot_indexes
                    if slot_idx != occupant_idx and result_items[slot_idx].room_id
                }
                available_for_occupant = [
                    room_id
                    for room_id in room_ids_ordered
                    if room_id not in used_without_occupant and room_id != preferred_room_id
                ]
                if not available_for_occupant:
                    continue

                if occupant_mode == "always" and occupant_preferred_set:
                    available_for_occupant = [
                        room_id for room_id in available_for_occupant if room_id in occupant_preferred_set
                    ]
                    if not available_for_occupant:
                        continue

                if (
                    occupant_mode == "once_per_week"
                    and occupant_preferred_set
                    and preferred_room_id in occupant_preferred_set
                    and any(
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] <= 1
                        for wk in occupant_week_keys
                    )
                ):
                    available_for_occupant = [
                        room_id for room_id in available_for_occupant if room_id in occupant_preferred_set
                    ]
                    if not available_for_occupant:
                        continue

                swap_room = _pick_with_consistency(
                    available_for_occupant,
                    occupant_item.subject_id,
                    occupant_item.week_type or "base",
                )
                if not swap_room:
                    continue

                _set_item_room(occupant_idx, swap_room)
                _set_item_room(target_idx, preferred_room_id)
                occupant_week_key = occupant_item.week_type or "base"
                subject_slot_room_by_week[(occupant_item.subject_id, occupant_item.timeslot_id, occupant_week_key)] = swap_room
                subject_slot_room_by_week[(subject_id, target_item.timeslot_id, target_week_key)] = preferred_room_id

                if preferred_room_id in occupant_preferred_set and swap_room not in occupant_preferred_set:
                    for wk in occupant_week_keys:
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] -= 1
                elif preferred_room_id not in occupant_preferred_set and swap_room in occupant_preferred_set:
                    for wk in occupant_week_keys:
                        preferred_count_by_subject_week[(occupant_item.subject_id, wk)] += 1

                for wk in _enforced_week_keys(result_items[target_idx]):
                    preferred_count_by_subject_week[(subject_id, wk)] += 1
                mirrored = True
                break

        # Final consistency pass: align rooms across A/B for the same
        # subject+timeslot whenever the mirrored room is available.
        for (subject_id, timeslot_id), week_map in subject_slot_week_index.items():
            if "A" not in week_map or "B" not in week_map:
                continue

            idx_a = week_map["A"]
            idx_b = week_map["B"]
            room_a = result_items[idx_a].room_id
            room_b = result_items[idx_b].room_id
            if not room_a or not room_b or room_a == room_b:
                continue

            # Prefer aligning B to A first.
            slot_key_b = (timeslot_id, result_items[idx_b].week_type)
            slot_indexes_b = items_by_slot_index.get(slot_key_b, [])
            used_rooms_b = {
                result_items[slot_idx].room_id
                for slot_idx in slot_indexes_b
                if slot_idx != idx_b and result_items[slot_idx].room_id
            }
            if room_a not in used_rooms_b:
                _set_item_room(idx_b, room_a)
                subject_slot_room_by_week[(subject_id, timeslot_id, "B")] = room_a
                continue

            # If that fails, try aligning A to B.
            slot_key_a = (timeslot_id, result_items[idx_a].week_type)
            slot_indexes_a = items_by_slot_index.get(slot_key_a, [])
            used_rooms_a = {
                result_items[slot_idx].room_id
                for slot_idx in slot_indexes_a
                if slot_idx != idx_a and result_items[slot_idx].room_id
            }
            if room_b not in used_rooms_a:
                _set_item_room(idx_a, room_b)
                subject_slot_room_by_week[(subject_id, timeslot_id, "A")] = room_b

    # Strict final normalization pass: for the same subject+timeslot in A/B,
    # use the same room whenever one side can adopt the other's room without
    # creating a room collision in that week/slot.
    items_by_slot_index_final: Dict[Tuple[str, str | None], List[int]] = defaultdict(list)
    for idx, item in enumerate(result_items):
        items_by_slot_index_final[(item.timeslot_id, item.week_type)].append(idx)

    subject_slot_week_index_final: Dict[Tuple[str, str], Dict[str, int]] = defaultdict(dict)
    for idx, item in enumerate(result_items):
        week_label = item.week_type or "base"
        if week_label in {"A", "B"}:
            subject_slot_week_index_final[(item.subject_id, item.timeslot_id)][week_label] = idx

    for (_subject_id, timeslot_id), week_map in subject_slot_week_index_final.items():
        if "A" not in week_map or "B" not in week_map:
            continue

        idx_a = week_map["A"]
        idx_b = week_map["B"]
        room_a = result_items[idx_a].room_id
        room_b = result_items[idx_b].room_id
        if not room_a or not room_b or room_a == room_b:
            continue

        slot_key_b = (timeslot_id, result_items[idx_b].week_type)
        used_rooms_b = {
            result_items[slot_idx].room_id
            for slot_idx in items_by_slot_index_final.get(slot_key_b, [])
            if slot_idx != idx_b and result_items[slot_idx].room_id
        }
        if room_a not in used_rooms_b:
            _set_item_room(idx_b, room_a)
            continue

        slot_key_a = (timeslot_id, result_items[idx_a].week_type)
        used_rooms_a = {
            result_items[slot_idx].room_id
            for slot_idx in items_by_slot_index_final.get(slot_key_a, [])
            if slot_idx != idx_a and result_items[slot_idx].room_id
        }
        if room_b not in used_rooms_a:
            _set_item_room(idx_a, room_b)

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


def _generate_schedule_staged(
    data: ScheduleRequest,
    week_label: str | None = None,
    week_unit_overrides: Dict[str, int] | None = None,
    allow_partial_remaining: bool = False,
    allow_partial_subject_ids: Set[str] | None = None,
    partial_min_units_by_subject: Dict[str, int] | None = None,
    seed_items: List[ScheduledItem] | None = None,
    cross_week_preferred_slots_by_class: Dict[str, Set[str]] | None = None,
    cross_week_preferred_slots_by_subject: Dict[str, Set[str]] | None = None,
    partial_subject_priority: str = "first",
    subject_priority_rank: Dict[str, int] | None = None,
    target_week_units_by_class: Dict[str, int] | None = None,
) -> ScheduleResponse:
    _solver_log(
        f"[RUN] generate_schedule_staged week={week_label or 'single'}",
        reset=(week_label is None or week_label == "A"),
    )

    active_timeslots = list(data.timeslots)
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
        if subject.subject_type != "fellesfag":
            continue
        for class_id in subject.class_ids:
            if class_id in class_to_base_room:
                subject_to_room[subject.id] = class_to_base_room[class_id]
                break

    sports_halls = data.sports_halls or []
    sports_hall_ids: Set[str] = {sh.id for sh in sports_halls}
    sports_only_subject_ids: Set[str] = {
        sid
        for sh in sports_halls
        for sid in (sh.allowed_subject_ids or [])
        if sid in subjects_by_id
    }
    sports_hall_capacity = len(sports_hall_ids)
    regular_room_capacity = len(data.rooms or [])
    sports_slot_usage_by_week: Dict[Tuple[str, str], int] = defaultdict(int)
    regular_room_slot_usage_by_week: Dict[Tuple[str, str], int] = defaultdict(int)

    def _is_force_locked_to_slot(subject: Subject | None, ts_id: str) -> bool:
        if not subject or not getattr(subject, "force_place", False):
            return False
        return (getattr(subject, "force_timeslot_id", "") or "").strip() == ts_id

    def _room_capacity_available(subject: Subject | None, ts_id: str, week_key: str) -> bool:
        if not subject:
            return True
        # Explicit force-place overrides hall-capacity placement checks.
        if _is_force_locked_to_slot(subject, ts_id):
            return True
        if subject.id in sports_only_subject_ids:
            if sports_hall_capacity <= 0:
                return False
            return sports_slot_usage_by_week[(week_key, ts_id)] < sports_hall_capacity
        if regular_room_capacity <= 0:
            return False
        return regular_room_slot_usage_by_week[(week_key, ts_id)] < regular_room_capacity

    def _increment_room_slot_usage(subject_id: str, ts_id: str, week_key: str) -> None:
        if subject_id in sports_only_subject_ids:
            sports_slot_usage_by_week[(week_key, ts_id)] += 1
        else:
            regular_room_slot_usage_by_week[(week_key, ts_id)] += 1

    def _decrement_room_slot_usage(subject_id: str, ts_id: str, week_key: str) -> None:
        if subject_id in sports_only_subject_ids:
            key = (week_key, ts_id)
            if sports_slot_usage_by_week[key] > 0:
                sports_slot_usage_by_week[key] -= 1
        else:
            key = (week_key, ts_id)
            if regular_room_slot_usage_by_week[key] > 0:
                regular_room_slot_usage_by_week[key] -= 1

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            if week_label:
                wt = (occ.week_type or "both").lower()
                if wt not in ("both", week_label.lower()):
                    continue
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

    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    # Teachers are immutable per subject entity. Never augment subject teachers
    # from block entries to avoid cross-subject teacher drift.
    subject_effective_teacher_ids: Dict[str, List[str]] = {s.id: _subject_teacher_ids(s) for s in data.subjects}

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
    seeded_units_by_subject: Dict[str, int] = defaultdict(int)
    seeded_days_by_subject: Dict[str, Set[str]] = defaultdict(set)
    partial_subject_ids = allow_partial_subject_ids or set()
    partial_min_units = partial_min_units_by_subject or {}
    subject_rank = subject_priority_rank or {}
    target_class_units = target_week_units_by_class or {}
    class_week_units: Dict[str, int] = defaultdict(int)

    def _partial_infeasible_response(message: str) -> ScheduleResponse:
        metadata: Dict[str, float] = {
            "partial": 1.0,
            "placed_count": float(len(schedule_items)),
        }
        if week_label == "A":
            metadata["failed_week_a"] = 1.0
        elif week_label == "B":
            metadata["failed_week_b"] = 1.0
        else:
            metadata["failed_week_single"] = 1.0

        return ScheduleResponse(
            status="infeasible",
            message=message,
            schedule=schedule_items,
            metadata=metadata,
        )

    day_period_bounds: Dict[str, Tuple[int, int]] = {}
    for ts in active_timeslots:
        if ts.day not in day_period_bounds:
            day_period_bounds[ts.day] = (ts.period, ts.period)
        else:
            min_p, max_p = day_period_bounds[ts.day]
            day_period_bounds[ts.day] = (min(min_p, ts.period), max(max_p, ts.period))

    def _is_boundary_period(day: str, period: int) -> bool:
        min_p, max_p = day_period_bounds.get(day, (period, period))
        return period in {min_p, max_p}

    def _slot_sort_key(ts_id: str) -> Tuple[str, int]:
        ts = timeslots_by_id[ts_id]
        day_index = DAY_ORDER_INDEX.get((ts.day or "").lower(), 99)
        return (day_index, ts.period)

    if seed_items:
        for item in seed_items:
            schedule_items.append(item)
            item_units = _item_units(item, timeslot_units_by_id)
            seeded_units_by_subject[item.subject_id] += item_units
            seeded_days_by_subject[item.subject_id].add(item.day)
            _increment_room_slot_usage(item.subject_id, item.timeslot_id, (item.week_type or "base"))
            for class_id in item.class_ids:
                class_occupied.add((class_id, item.timeslot_id))
                class_day_load_units[(class_id, item.day)] += item_units
                class_week_units[class_id] += item_units

            seeded_teacher_ids = list(dict.fromkeys([
                *(item.teacher_ids or []),
                *([item.teacher_id] if item.teacher_id else []),
            ]))
            for teacher_id in seeded_teacher_ids:
                teacher_occupied.add((teacher_id, item.timeslot_id))

    # Step 0: force-placed subjects (typically fellesfag class copies) are inserted
    # before block reservation. They reserve teacher/class occupancy for other
    # non-block subjects, but block subjects may still overlap by design.
    for subject in sorted(data.subjects, key=lambda s: s.name.lower()):
        if not getattr(subject, "force_place", False):
            continue
        forced_ts_id = (getattr(subject, "force_timeslot_id", "") or "").strip()
        if not forced_ts_id:
            continue
        if forced_ts_id not in all_timeslot_ids:
            return _partial_infeasible_response(
                f"Forced slot '{forced_ts_id}' for subject '{subject.name}' ({subject.id}) "
                f"does not exist in active timeslots."
            )

        if week_label in {"A", "B"}:
            allowed_weeks = _compute_allowed_weeks(subject, True, blocks_by_id, linked_block_ids)
            if week_label not in allowed_weeks:
                continue

        teacher_ids = subject_effective_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        primary_teacher_id = teacher_ids[0] if teacher_ids else ""

        # Do not duplicate if this week already has the forced slot from seeding.
        if any(
            item.subject_id == subject.id
            and item.timeslot_id == forced_ts_id
            and (item.week_type or "base") == (week_label or "base")
            for item in schedule_items
        ):
            continue

        for teacher_id in teacher_ids:
            if teacher_id in teachers_by_id:
                if forced_ts_id in set(teachers_by_id[teacher_id].unavailable_timeslots):
                    return _partial_infeasible_response(
                        f"Forced placement for '{subject.name}' ({subject.id}) conflicts with "
                        f"teacher availability ({teacher_id}) at slot {forced_ts_id}."
                    )
            if forced_ts_id in teacher_meeting_unavailable.get(teacher_id, set()):
                return _partial_infeasible_response(
                    f"Forced placement for '{subject.name}' ({subject.id}) conflicts with "
                    f"teacher meeting lock ({teacher_id}) at slot {forced_ts_id}."
                )
            if (teacher_id, forced_ts_id) in teacher_occupied:
                return _partial_infeasible_response(
                    f"Forced placement for '{subject.name}' ({subject.id}) conflicts with another "
                    f"teacher assignment ({teacher_id}) at slot {forced_ts_id}."
                )

        for class_id in subject.class_ids:
            if (class_id, forced_ts_id) in class_occupied:
                return _partial_infeasible_response(
                    f"Forced placement for '{subject.name}' ({subject.id}) conflicts with another "
                    f"class assignment ({class_id}) at slot {forced_ts_id}."
                )

        ts = timeslots_by_id[forced_ts_id]
        schedule_items.append(
            ScheduledItem(
                subject_id=subject.id,
                subject_name=subject.name,
                teacher_id=primary_teacher_id,
                teacher_ids=teacher_ids,
                class_ids=subject.class_ids,
                timeslot_id=forced_ts_id,
                day=ts.day,
                period=ts.period,
                week_type=week_label,
                room_id=subject_to_room.get(subject.id),
            )
        )

        forced_units = timeslot_units_by_id.get(forced_ts_id, 1)
        seeded_units_by_subject[subject.id] += forced_units
        seeded_days_by_subject[subject.id].add(ts.day)
        for class_id in subject.class_ids:
            class_occupied.add((class_id, forced_ts_id))
            class_day_load_units[(class_id, ts.day)] += forced_units
            class_week_units[class_id] += forced_units
        for teacher_id in teacher_ids:
            teacher_occupied.add((teacher_id, forced_ts_id))
        _increment_room_slot_usage(subject.id, forced_ts_id, (week_label or "base"))

    block_subject_ids: Set[str] = set(linked_block_ids.keys())

    for block in data.blocks:
        block_slots = sorted(block_to_timeslots.get(block.id, set()), key=_slot_sort_key)
        if not block_slots:
            continue

        week_specific_slot_ids: Set[str] = set()
        if week_label:
            for occ in block.occurrences:
                occ_week = (occ.week_type or "both").upper()
                if occ_week != week_label.upper():
                    continue
                week_specific_slot_ids |= (_timeslots_overlapping_occurrence(occ, active_timeslots) & all_timeslot_ids)

        slot_span_by_id: Dict[str, Tuple[str, str]] = {}
        for occ in block.occurrences:
            if week_label:
                wt = (occ.week_type or "both").lower()
                if wt not in ("both", week_label.lower()):
                    continue
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

        ordered_relevant_subject_ids = sorted(relevant_subject_ids)
        if week_label and cross_week_preferred_slots_by_subject:
            ordered_relevant_subject_ids = sorted(
                relevant_subject_ids,
                key=lambda sid: (
                    -len(set(block_slots) & set(cross_week_preferred_slots_by_subject.get(sid, set()))),
                    sid,
                ),
            )

        for subject_id in ordered_relevant_subject_ids:
            subject = subjects_by_id[subject_id]
            # Classless subjects inside a block should occupy that block's class set.
            placement_class_ids = list(subject.class_ids or block.class_ids or [])
            teacher_ids = subject_effective_teacher_ids.get(subject_id, _subject_teacher_ids(subject))
            primary_teacher_id = teacher_ids[0] if teacher_ids else ""

            subject_allowed_slots = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots, timeslots_by_id)
            candidate_slots = [ts_id for ts_id in block_slots if ts_id in subject_allowed_slots]
            if week_label and week_specific_slot_ids:
                candidate_slots.sort(
                    key=lambda ts_id: (
                        0 if ts_id in week_specific_slot_ids else 1,
                        _slot_sort_key(ts_id),
                    )
                )
            if week_label and cross_week_preferred_slots_by_subject:
                preferred_cross_week_slots = set(cross_week_preferred_slots_by_subject.get(subject.id, set()))
                if preferred_cross_week_slots:
                    candidate_slots.sort(
                        key=lambda ts_id: (
                            0 if (week_specific_slot_ids and ts_id in week_specific_slot_ids) else 1,
                            0 if ts_id in preferred_cross_week_slots else 1,
                            _slot_sort_key(ts_id),
                        )
                    )
            # Block subjects are slot-driven: place according to block windows,
            # not sessions_per_week unit targets.
            fill_all_block_slots = True
            required_units = sum(timeslot_units_by_id.get(ts_id, 1) for ts_id in candidate_slots)
            subject_requires_odd_units = (required_units % 2) == 1

            units_placed = 0
            rendered_span_keys: Set[str] = set()
            for ts_id in candidate_slots:
                if not _room_capacity_available(subject, ts_id, week_label or "base"):
                    continue
                if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                    continue

                custom_span = slot_span_by_id.get(ts_id)
                custom_start = custom_span[0] if custom_span else None
                custom_end = custom_span[1] if custom_span else None

                # Enforce reduced-tail parity rule in block path as well.
                if custom_start and custom_end:
                    reduced_spans_for_subject = {
                        reduced_tail_span_by_class_slot[(class_id, ts_id)]
                        for class_id in placement_class_ids
                        if (class_id, ts_id) in reduced_tail_span_by_class_slot
                    }
                    has_subject_reduced_tail = len(reduced_spans_for_subject) > 0
                    if has_subject_reduced_tail:
                        all_classes_in_tail = len(placement_class_ids) == sum(
                            1 for class_id in placement_class_ids if (class_id, ts_id) in reduced_tail_span_by_class_slot
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
                            class_ids=placement_class_ids,
                            timeslot_id=ts_id,
                            day=timeslots_by_id[ts_id].day,
                            period=timeslots_by_id[ts_id].period,
                            start_time=custom_start,
                            end_time=custom_end,
                            week_type=week_label,
                            room_id=subject_to_room.get(subject.id),
                        )
                    )

                for class_id in placement_class_ids:
                    if (class_id, ts_id) not in reduced_tail_span_by_class_slot:
                        class_occupied.add((class_id, ts_id))
                if teacher_ids and not any(
                    (class_id, ts_id) in reduced_tail_span_by_class_slot for class_id in placement_class_ids
                ):
                    for teacher_id in teacher_ids:
                        teacher_occupied.add((teacher_id, ts_id))

                units_placed += timeslot_units_by_id.get(ts_id, 1)
                _increment_room_slot_usage(subject.id, ts_id, (week_label or "base"))
                for class_id in placement_class_ids:
                    class_day_load_units[(class_id, timeslots_by_id[ts_id].day)] += timeslot_units_by_id.get(ts_id, 1)
                    class_week_units[class_id] += timeslot_units_by_id.get(ts_id, 1)
                if not fill_all_block_slots and units_placed >= required_units:
                    break

    # Step 2: meetings lock teacher availability for the rest of planning.
    for teacher_id, slot_ids in teacher_meeting_unavailable.items():
        for ts_id in slot_ids:
            teacher_occupied.add((teacher_id, ts_id))

    # Step 3: place all remaining subjects in currently available slots.
    remaining_subjects = [s for s in data.subjects if s.id not in block_subject_ids]
    remaining_subject_ids: Set[str] = {s.id for s in remaining_subjects}

    link_members_by_group_id: Dict[str, List[str]] = defaultdict(list)
    for subject in remaining_subjects:
        group_id = _subject_link_group_id(subject)
        if not group_id:
            continue
        if subject.subject_type != "fellesfag" or len(subject.class_ids or []) != 1:
            continue
        link_members_by_group_id[group_id].append(subject.id)

    for group_id, member_ids in list(link_members_by_group_id.items()):
        unique_ids = [sid for sid in dict.fromkeys(member_ids) if sid in remaining_subject_ids]
        if len(unique_ids) < 2:
            del link_members_by_group_id[group_id]
            continue
        link_members_by_group_id[group_id] = sorted(unique_ids)

    link_leader_by_group_id: Dict[str, str] = {
        group_id: member_ids[0]
        for group_id, member_ids in link_members_by_group_id.items()
        if member_ids
    }
    link_group_by_subject_id: Dict[str, str] = {}
    link_leader_by_subject_id: Dict[str, str] = {}
    link_followers_by_leader_id: Dict[str, List[str]] = defaultdict(list)
    for group_id, member_ids in link_members_by_group_id.items():
        leader_id = link_leader_by_group_id[group_id]
        for subject_id in member_ids:
            link_group_by_subject_id[subject_id] = group_id
            link_leader_by_subject_id[subject_id] = leader_id
            if subject_id != leader_id:
                link_followers_by_leader_id[leader_id].append(subject_id)

    def _required_units_for_subject(subject: Subject) -> int:
        has_week_override = bool(week_unit_overrides is not None and subject.id in week_unit_overrides)
        week_sessions = (
            week_unit_overrides.get(subject.id, subject.sessions_per_week)
            if week_unit_overrides
            else subject.sessions_per_week
        )
        if has_week_override:
            return max(0, int(week_sessions or 0))
        return max(1, int(week_sessions or 1))

    def _initial_subject_flex(subject: Subject) -> Tuple[int, int, int, int]:
        teacher_ids_local = subject_effective_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        allowed_slots_local = _compute_allowed_timeslots(
            subject,
            all_timeslot_ids,
            block_to_timeslots,
            timeslots_by_id,
        )

        for tid in teacher_ids_local:
            if tid in teachers_by_id:
                allowed_slots_local -= set(teachers_by_id[tid].unavailable_timeslots)
                allowed_slots_local -= teacher_meeting_unavailable.get(tid, set())

        feasible_count = 0
        feasible_days: Set[str] = set()
        feasible_capacity_units = 0
        planning_week_key_local = week_label or "base"
        for ts_id in allowed_slots_local:
            if not _room_capacity_available(subject, ts_id, planning_week_key_local):
                continue
            if any((tid, ts_id) in teacher_occupied for tid in teacher_ids_local):
                continue
            if any((cid, ts_id) in class_occupied for cid in subject.class_ids):
                continue
            feasible_count += 1
            feasible_days.add(timeslots_by_id[ts_id].day)
            feasible_capacity_units += timeslot_units_by_id.get(ts_id, 1)

        required_units_local = _required_units_for_subject(subject)
        slack_units = feasible_capacity_units - required_units_local

        return feasible_count, len(feasible_days), feasible_capacity_units, slack_units

    subject_flex_by_id: Dict[str, Tuple[int, int]] = {
        s.id: _initial_subject_flex(s)
        for s in remaining_subjects
    }

    remaining_subjects.sort(
        key=lambda s: (
            (0 if s.id in partial_subject_ids else 1)
            if partial_subject_priority == "first"
            else (1 if s.id in partial_subject_ids else 0),
            subject_flex_by_id.get(s.id, (10_000, 10_000, 10_000, 10_000))[3],
            (
                0
                if (
                    s.id in sports_only_subject_ids
                    and subject_flex_by_id.get(s.id, (10_000, 10_000, 10_000, 10_000))[3] <= 2
                )
                else 1
            ),
            subject_flex_by_id.get(s.id, (10_000, 10_000, 10_000, 10_000))[0],
            subject_flex_by_id.get(s.id, (10_000, 10_000, 10_000, 10_000))[1],
            subject_rank.get(s.id, 10_000),
            -_required_units_for_subject(s),
            s.name.lower(),
        )
    )

    initial_order_rank: Dict[str, int] = {subject.id: idx for idx, subject in enumerate(remaining_subjects)}
    remaining_subject_by_id: Dict[str, Subject] = {subject.id: subject for subject in remaining_subjects}
    ordered_remaining_subjects: List[Subject] = []
    added_subject_ids: Set[str] = set()
    for subject in remaining_subjects:
        if subject.id in added_subject_ids:
            continue
        group_id = link_group_by_subject_id.get(subject.id, "")
        if not group_id:
            ordered_remaining_subjects.append(subject)
            added_subject_ids.add(subject.id)
            continue

        leader_id = link_leader_by_group_id.get(group_id, "")
        if not leader_id:
            ordered_remaining_subjects.append(subject)
            added_subject_ids.add(subject.id)
            continue

        member_ids = sorted(
            link_members_by_group_id.get(group_id, []),
            key=lambda sid: (0 if sid == leader_id else 1, initial_order_rank.get(sid, 10_000)),
        )
        for member_id in member_ids:
            if member_id in added_subject_ids:
                continue
            linked_subject = remaining_subject_by_id.get(member_id)
            if not linked_subject:
                continue
            ordered_remaining_subjects.append(linked_subject)
            added_subject_ids.add(member_id)

    remaining_subjects = ordered_remaining_subjects

    subject_allowed_slots_without_occupancy: Dict[str, Set[str]] = {}
    for subject in remaining_subjects:
        subject_allowed = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots, timeslots_by_id)
        teacher_ids = subject_effective_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        for teacher_id in teacher_ids:
            if teacher_id in teachers_by_id:
                subject_allowed -= set(teachers_by_id[teacher_id].unavailable_timeslots)
                subject_allowed -= teacher_meeting_unavailable.get(teacher_id, set())
        subject_allowed_slots_without_occupancy[subject.id] = subject_allowed

    def _try_open_room_capacity_for_locked_slot(
        target_subject: Subject,
        target_slot_id: str,
        week_key: str,
        protected_subject_ids: Set[str] | None = None,
    ) -> bool:
        if _room_capacity_available(target_subject, target_slot_id, week_key):
            return True

        protected_ids = set(protected_subject_ids or set())
        target_is_sports = target_subject.id in sports_only_subject_ids

        for existing_item in schedule_items:
            if (existing_item.week_type or "base") != week_key:
                continue
            if existing_item.timeslot_id != target_slot_id:
                continue

            existing_subject = subjects_by_id.get(existing_item.subject_id)
            if not existing_subject:
                continue
            if existing_subject.id in protected_ids:
                continue
            if existing_subject.id in block_subject_ids:
                continue
            if existing_subject.id in link_group_by_subject_id:
                continue
            if existing_subject.force_place and (existing_subject.force_timeslot_id or "").strip():
                continue
            if existing_item.start_time and existing_item.end_time:
                continue

            existing_is_sports = existing_subject.id in sports_only_subject_ids
            if existing_is_sports != target_is_sports:
                continue

            existing_teacher_ids = subject_effective_teacher_ids.get(
                existing_subject.id,
                _subject_teacher_ids(existing_subject),
            )
            existing_allowed_slots = sorted(
                list(subject_allowed_slots_without_occupancy.get(existing_subject.id, set())),
                key=_slot_sort_key,
            )
            if not existing_allowed_slots:
                continue

            old_slot_id = existing_item.timeslot_id
            old_day = existing_item.day
            old_period = existing_item.period
            existing_units = _item_units(existing_item, timeslot_units_by_id)

            for alt_slot_id in existing_allowed_slots:
                if alt_slot_id == old_slot_id:
                    continue
                if not _room_capacity_available(existing_subject, alt_slot_id, week_key):
                    continue

                for class_id in existing_subject.class_ids:
                    class_occupied.discard((class_id, old_slot_id))
                for teacher_id in existing_teacher_ids:
                    teacher_occupied.discard((teacher_id, old_slot_id))

                alt_conflict = False
                if any((teacher_id, alt_slot_id) in teacher_occupied for teacher_id in existing_teacher_ids):
                    alt_conflict = True
                if any((class_id, alt_slot_id) in class_occupied for class_id in existing_subject.class_ids):
                    alt_conflict = True

                if alt_conflict:
                    for class_id in existing_subject.class_ids:
                        class_occupied.add((class_id, old_slot_id))
                    for teacher_id in existing_teacher_ids:
                        teacher_occupied.add((teacher_id, old_slot_id))
                    continue

                alt_slot = timeslots_by_id[alt_slot_id]
                existing_item.timeslot_id = alt_slot_id
                existing_item.day = alt_slot.day
                existing_item.period = alt_slot.period
                existing_item.start_time = None
                existing_item.end_time = None

                for class_id in existing_subject.class_ids:
                    class_occupied.add((class_id, alt_slot_id))
                for teacher_id in existing_teacher_ids:
                    teacher_occupied.add((teacher_id, alt_slot_id))

                for class_id in existing_subject.class_ids:
                    class_day_load_units[(class_id, old_day)] -= existing_units
                    class_day_load_units[(class_id, alt_slot.day)] += existing_units

                _decrement_room_slot_usage(existing_subject.id, old_slot_id, week_key)
                _increment_room_slot_usage(existing_subject.id, alt_slot_id, week_key)

                if _room_capacity_available(target_subject, target_slot_id, week_key):
                    _solver_log(
                        f"[LINK-ROOM-RELOCATE] moved {existing_subject.id} {old_slot_id}->{alt_slot_id} "
                        f"to free {target_subject.id} in week {week_key}"
                    )
                    return True

                # Revert if relocation did not free enough capacity.
                _decrement_room_slot_usage(existing_subject.id, alt_slot_id, week_key)
                _increment_room_slot_usage(existing_subject.id, old_slot_id, week_key)
                for class_id in existing_subject.class_ids:
                    class_occupied.discard((class_id, alt_slot_id))
                for teacher_id in existing_teacher_ids:
                    teacher_occupied.discard((teacher_id, alt_slot_id))
                for class_id in existing_subject.class_ids:
                    class_occupied.add((class_id, old_slot_id))
                for teacher_id in existing_teacher_ids:
                    teacher_occupied.add((teacher_id, old_slot_id))
                for class_id in existing_subject.class_ids:
                    class_day_load_units[(class_id, alt_slot.day)] -= existing_units
                    class_day_load_units[(class_id, old_day)] += existing_units
                old_slot = timeslots_by_id[old_slot_id]
                existing_item.timeslot_id = old_slot_id
                existing_item.day = old_slot.day
                existing_item.period = old_period
                existing_item.start_time = None
                existing_item.end_time = None

        return False

    seeded_boundary_count_by_subject: Dict[str, int] = defaultdict(int)
    seeded_first_boundary_count_by_subject: Dict[str, int] = defaultdict(int)
    seeded_last_boundary_count_by_subject: Dict[str, int] = defaultdict(int)
    for existing_item in schedule_items:
        min_p, max_p = day_period_bounds.get(existing_item.day, (existing_item.period, existing_item.period))
        if existing_item.period == min_p or existing_item.period == max_p:
            seeded_boundary_count_by_subject[existing_item.subject_id] += 1
        if existing_item.period == min_p:
            seeded_first_boundary_count_by_subject[existing_item.subject_id] += 1
        if existing_item.period == max_p:
            seeded_last_boundary_count_by_subject[existing_item.subject_id] += 1

    for subject in remaining_subjects:
        teacher_ids = subject_effective_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        primary_teacher_id = teacher_ids[0] if teacher_ids else ""
        is_norsk_vg3 = _is_norsk_vg3_subject(subject)
        is_matematikk = "matematikk" in (subject.name or "").lower()
        required_units = _required_units_for_subject(subject)
        subject_requires_odd_units = (required_units % 2) == 1
        allowed_slots = set(subject_allowed_slots_without_occupancy.get(subject.id, set()))

        if required_units == 0:
            continue

        candidate_slots = sorted(allowed_slots, key=_slot_sort_key)
        has_thursday_candidate = any(
            (timeslots_by_id[ts_id].day or "").lower() == "thursday"
            for ts_id in candidate_slots
        )
        units_placed = seeded_units_by_subject.get(subject.id, 0)

        linked_group_id = link_group_by_subject_id.get(subject.id, "")
        linked_leader_id = link_leader_by_subject_id.get(subject.id, "")
        is_linked_follower = bool(linked_group_id and linked_leader_id and linked_leader_id != subject.id)
        planning_week_key = week_label or "base"

        if is_linked_follower:
            linked_leader_items = sorted(
                [
                    item
                    for item in schedule_items
                    if item.subject_id == linked_leader_id and (item.week_type or "base") == planning_week_key
                ],
                key=lambda item: (item.day, item.period, item.timeslot_id),
            )

            leader_required_units = sum(_item_units(item, timeslot_units_by_id) for item in linked_leader_items)
            if leader_required_units != required_units:
                return _partial_infeasible_response(
                    f"Linked subject '{subject.name}' ({subject.id}) requires {required_units}u, "
                    f"but linked leader ({linked_leader_id}) is scheduled for {leader_required_units}u in week {planning_week_key}."
                )

            existing_linked_items = sorted(
                [
                    item
                    for item in schedule_items
                    if item.subject_id == subject.id and (item.week_type or "base") == planning_week_key
                ],
                key=lambda item: (item.day, item.period, item.timeslot_id),
            )
            existing_counts: Counter[Tuple[str, int, str]] = Counter(
                (item.timeslot_id, _item_units(item, timeslot_units_by_id), item.day)
                for item in existing_linked_items
            )
            leader_counts: Counter[Tuple[str, int, str]] = Counter(
                (item.timeslot_id, _item_units(item, timeslot_units_by_id), item.day)
                for item in linked_leader_items
            )
            for signature, count in existing_counts.items():
                if count > leader_counts.get(signature, 0):
                    return _partial_infeasible_response(
                        f"Linked subject '{subject.name}' ({subject.id}) has seeded placements that cannot match "
                        f"linked leader ({linked_leader_id}) in week {planning_week_key}."
                    )

            for leader_item in linked_leader_items:
                signature = (leader_item.timeslot_id, _item_units(leader_item, timeslot_units_by_id), leader_item.day)
                if existing_counts.get(signature, 0) > 0:
                    existing_counts[signature] -= 1
                    continue

                linked_slot_id = leader_item.timeslot_id
                if linked_slot_id not in allowed_slots:
                    return _partial_infeasible_response(
                        f"Linked subject '{subject.name}' ({subject.id}) cannot use slot {linked_slot_id} "
                        f"required by its link group ({linked_group_id})."
                    )
                if not _room_capacity_available(subject, linked_slot_id, planning_week_key):
                    _try_open_room_capacity_for_locked_slot(
                        subject,
                        linked_slot_id,
                        planning_week_key,
                        protected_subject_ids={subject.id, linked_leader_id},
                    )
                if not _room_capacity_available(subject, linked_slot_id, planning_week_key):
                    return _partial_infeasible_response(
                        f"Linked subject '{subject.name}' ({subject.id}) cannot use slot {linked_slot_id} "
                        f"because no compatible room is available in week {planning_week_key}."
                    )
                if any((teacher_id, linked_slot_id) in teacher_occupied for teacher_id in teacher_ids):
                    return _partial_infeasible_response(
                        f"Linked subject '{subject.name}' ({subject.id}) conflicts with teacher occupancy "
                        f"at slot {linked_slot_id}."
                    )
                if any((class_id, linked_slot_id) in class_occupied for class_id in subject.class_ids):
                    return _partial_infeasible_response(
                        f"Linked subject '{subject.name}' ({subject.id}) conflicts with class occupancy "
                        f"at slot {linked_slot_id}."
                    )

                linked_slot = timeslots_by_id[linked_slot_id]
                placed_units = _item_units(leader_item, timeslot_units_by_id)
                schedule_items.append(
                    ScheduledItem(
                        subject_id=subject.id,
                        subject_name=subject.name,
                        teacher_id=primary_teacher_id,
                        teacher_ids=teacher_ids,
                        class_ids=subject.class_ids,
                        timeslot_id=linked_slot_id,
                        day=linked_slot.day,
                        period=linked_slot.period,
                        start_time=leader_item.start_time,
                        end_time=leader_item.end_time,
                        week_type=week_label,
                        room_id=subject_to_room.get(subject.id),
                    )
                )

                for class_id in subject.class_ids:
                    class_occupied.add((class_id, linked_slot_id))
                    class_day_load_units[(class_id, linked_slot.day)] += placed_units
                    class_week_units[class_id] += placed_units
                for teacher_id in teacher_ids:
                    teacher_occupied.add((teacher_id, linked_slot_id))
                _increment_room_slot_usage(subject.id, linked_slot_id, planning_week_key)

                units_placed += placed_units

            continue

        subject_days_used: Set[str] = set(seeded_days_by_subject.get(subject.id, set()))
        max_units_by_day: Dict[str, int] = {}
        for ts_id in candidate_slots:
            ts_day = timeslots_by_id[ts_id].day
            max_units_by_day[ts_day] = max(max_units_by_day.get(ts_day, 0), timeslot_units_by_id.get(ts_id, 1))
        strict_day_capacity = sum(max_units_by_day.values())
        allow_same_day_if_needed = strict_day_capacity < required_units
        enforce_unique_day = not is_norsk_vg3
        subject_boundary_count = seeded_boundary_count_by_subject.get(subject.id, 0)
        subject_first_boundary_count = seeded_first_boundary_count_by_subject.get(subject.id, 0)
        subject_last_boundary_count = seeded_last_boundary_count_by_subject.get(subject.id, 0)

        subject_periods_by_day: Dict[str, Set[int]] = defaultdict(set)
        for existing_item in schedule_items:
            if existing_item.subject_id == subject.id:
                subject_periods_by_day[existing_item.day].add(existing_item.period)
        relocation_attempts_used = 0

        def _try_relocate_conflict_for_sports(target_slots: List[str], enforce_unique_day_now: bool) -> bool:
            # Sports subjects are capacity-constrained and should get first claim on compatible windows.
            if subject.id not in sports_only_subject_ids:
                return False
            if relocation_attempts_used >= 2:
                return False

            for ts_id in target_slots:
                ts = timeslots_by_id[ts_id]
                if enforce_unique_day_now and ts.day in subject_days_used:
                    continue
                if not _room_capacity_available(subject, ts_id, planning_week_key):
                    continue

                blocking_indexes: List[int] = []
                for idx, existing_item in enumerate(schedule_items):
                    if (existing_item.week_type or "base") != planning_week_key:
                        continue
                    if existing_item.timeslot_id != ts_id:
                        continue

                    class_conflict = bool(set(existing_item.class_ids or []) & set(subject.class_ids or []))
                    teacher_conflict = bool(set(_scheduled_item_teacher_ids(existing_item)) & set(teacher_ids or []))
                    if class_conflict or teacher_conflict:
                        blocking_indexes.append(idx)

                if len(blocking_indexes) != 1:
                    continue

                blocker_idx = blocking_indexes[0]
                blocker_item = schedule_items[blocker_idx]
                blocker_subject = subjects_by_id.get(blocker_item.subject_id)
                if not blocker_subject:
                    continue
                if blocker_subject.id in sports_only_subject_ids:
                    continue
                if blocker_subject.id in block_subject_ids:
                    continue
                if blocker_subject.id in link_group_by_subject_id:
                    continue
                if blocker_item.start_time and blocker_item.end_time:
                    continue

                blocker_teacher_ids = subject_effective_teacher_ids.get(
                    blocker_subject.id,
                    _subject_teacher_ids(blocker_subject),
                )
                blocker_allowed = sorted(
                    list(subject_allowed_slots_without_occupancy.get(blocker_subject.id, set())),
                    key=_slot_sort_key,
                )
                blocker_units = _item_units(blocker_item, timeslot_units_by_id)

                for alt_ts_id in blocker_allowed:
                    if alt_ts_id == ts_id:
                        continue
                    if not _room_capacity_available(blocker_subject, alt_ts_id, planning_week_key):
                        continue

                    blocker_old_slot_id = blocker_item.timeslot_id
                    old_day = blocker_item.day
                    old_period = blocker_item.period

                    for class_id in blocker_subject.class_ids:
                        class_occupied.discard((class_id, blocker_old_slot_id))
                    for teacher_id in blocker_teacher_ids:
                        teacher_occupied.discard((teacher_id, blocker_old_slot_id))

                    alt_conflict = False
                    if any((teacher_id, alt_ts_id) in teacher_occupied for teacher_id in blocker_teacher_ids):
                        alt_conflict = True
                    if any((class_id, alt_ts_id) in class_occupied for class_id in blocker_subject.class_ids):
                        alt_conflict = True

                    if alt_conflict:
                        for class_id in blocker_subject.class_ids:
                            class_occupied.add((class_id, blocker_old_slot_id))
                        for teacher_id in blocker_teacher_ids:
                            teacher_occupied.add((teacher_id, blocker_old_slot_id))
                        continue

                    alt_slot = timeslots_by_id[alt_ts_id]

                    blocker_item.timeslot_id = alt_ts_id
                    blocker_item.day = alt_slot.day
                    blocker_item.period = alt_slot.period
                    blocker_item.start_time = None
                    blocker_item.end_time = None

                    for class_id in blocker_subject.class_ids:
                        class_occupied.add((class_id, alt_ts_id))
                    for teacher_id in blocker_teacher_ids:
                        teacher_occupied.add((teacher_id, alt_ts_id))

                    for class_id in blocker_subject.class_ids:
                        class_day_load_units[(class_id, old_day)] -= blocker_units
                        class_day_load_units[(class_id, alt_slot.day)] += blocker_units
                    _decrement_room_slot_usage(blocker_subject.id, blocker_old_slot_id, planning_week_key)
                    _increment_room_slot_usage(blocker_subject.id, alt_ts_id, planning_week_key)

                    _solver_log(
                        f"[SPORTS-RELOCATE] moved {blocker_subject.id} {blocker_old_slot_id}->{alt_ts_id} "
                        f"to open {subject.id} in week {planning_week_key}"
                    )
                    return True

            return False

        def _has_norsk_target_pair() -> bool:
            for periods in subject_periods_by_day.values():
                if 1 in periods and 2 in periods:
                    return True
                if 3 in periods and 4 in periods:
                    return True
            return False

        while units_placed < required_units:
            remaining_units = required_units - units_placed
            prefer_single_unit_first = (
                week_label == "A"
                and subject.id in partial_subject_ids
                and (remaining_units % 2) == 1
            )

            preferred_slot_union: Set[str] = set()
            if cross_week_preferred_slots_by_subject:
                preferred_slot_union |= cross_week_preferred_slots_by_subject.get(subject.id, set())
            if not preferred_slot_union and cross_week_preferred_slots_by_class and subject.class_ids:
                for class_id in subject.class_ids:
                    preferred_slot_union |= cross_week_preferred_slots_by_class.get(class_id, set())

            slot_passes: List[List[str]] = []
            if preferred_slot_union:
                preferred_slots = [ts_id for ts_id in candidate_slots if ts_id in preferred_slot_union]
                if preferred_slots:
                    slot_passes.append(preferred_slots)
            slot_passes.append(candidate_slots)

            feasible_candidates: List[Tuple[Tuple[int, int, int, int, str, int], str, str | None, str | None, int]] = []

            for slot_candidates in slot_passes:
                feasible_candidates = []
                for ts_id in slot_candidates:
                    if not _room_capacity_available(subject, ts_id, planning_week_key):
                        continue
                    if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                        continue
                    if any((class_id, ts_id) in class_occupied for class_id in subject.class_ids):
                        continue

                    if subject.id in link_followers_by_leader_id:
                        linked_follower_ids = link_followers_by_leader_id.get(subject.id, [])
                        linked_slot_valid = True
                        for follower_id in linked_follower_ids:
                            follower_subject = subjects_by_id.get(follower_id)
                            if not follower_subject:
                                continue
                            follower_allowed_slots = subject_allowed_slots_without_occupancy.get(follower_id, set())
                            if ts_id not in follower_allowed_slots:
                                linked_slot_valid = False
                                break
                            if not _room_capacity_available(follower_subject, ts_id, planning_week_key):
                                _try_open_room_capacity_for_locked_slot(
                                    follower_subject,
                                    ts_id,
                                    planning_week_key,
                                    protected_subject_ids={subject.id, follower_id},
                                )
                                if not _room_capacity_available(follower_subject, ts_id, planning_week_key):
                                    linked_slot_valid = False
                                    break

                            follower_teacher_ids = subject_effective_teacher_ids.get(
                                follower_id,
                                _subject_teacher_ids(follower_subject),
                            )
                            if any((teacher_id, ts_id) in teacher_occupied for teacher_id in follower_teacher_ids):
                                linked_slot_valid = False
                                break
                            if any((class_id, ts_id) in class_occupied for class_id in follower_subject.class_ids):
                                linked_slot_valid = False
                                break

                        if not linked_slot_valid:
                            continue

                    ts = timeslots_by_id[ts_id]
                    if enforce_unique_day and ts.day in subject_days_used:
                        continue
                    if is_norsk_vg3:
                        same_day_repeat_penalty = 1 if ts.day in subject_days_used else 0
                        if not _has_norsk_target_pair():
                            same_day_repeat_penalty = 0 if ts.day in subject_days_used else 1
                    else:
                        same_day_repeat_penalty = 1 if ts.day in subject_days_used else 0

                    thursday_math_penalty = 0
                    if is_matematikk and has_thursday_candidate:
                        has_thursday_already = any((day or "").lower() == "thursday" for day in subject_days_used)
                        if not has_thursday_already:
                            thursday_math_penalty = 0 if (ts.day or "").lower() == "thursday" else 1

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

                    # Guard against immediate dead-ends for this subject:
                    # after choosing this slot, the remaining currently free slots
                    # must still be able to satisfy the remaining required units.
                    remaining_capacity_after = 0
                    for other_ts_id in candidate_slots:
                        if other_ts_id == ts_id:
                            continue
                        if not _room_capacity_available(subject, other_ts_id, planning_week_key):
                            continue
                        if any((teacher_id, other_ts_id) in teacher_occupied for teacher_id in teacher_ids):
                            continue
                        if any((class_id, other_ts_id) in class_occupied for class_id in subject.class_ids):
                            continue
                        if enforce_unique_day and timeslots_by_id[other_ts_id].day in subject_days_used:
                            continue

                        other_reduced_spans = {
                            reduced_tail_span_by_class_slot[(class_id, other_ts_id)]
                            for class_id in subject.class_ids
                            if (class_id, other_ts_id) in reduced_tail_span_by_class_slot
                        }
                        other_has_partial_tail = len(other_reduced_spans) > 0
                        if other_has_partial_tail:
                            if len(other_reduced_spans) != 1 or len(subject.class_ids) != sum(
                                1 for class_id in subject.class_ids if (class_id, other_ts_id) in reduced_tail_span_by_class_slot
                            ):
                                continue
                            if not subject_requires_odd_units:
                                continue
                            remaining_capacity_after += 1
                            continue

                        remaining_capacity_after += timeslot_units_by_id.get(other_ts_id, 1)

                    if remaining_capacity_after < (remaining_units - units_for_placement):
                        continue

                    would_overshoot = 1 if units_for_placement > remaining_units else 0
                    exact_fit_penalty = 0 if units_for_placement == remaining_units else 1
                    single_unit_penalty = 0
                    if prefer_single_unit_first:
                        single_unit_penalty = 0 if units_for_placement == 1 else 1
                    odd_tail_priority_penalty = 0
                    if subject_requires_odd_units and (remaining_units % 2) == 1:
                        odd_tail_priority_penalty = 0 if has_partial_tail else 1

                    cross_week_pair_penalty = 0
                    if preferred_slot_union and ts_id not in preferred_slot_union:
                        cross_week_pair_penalty = 1

                    excluded_slot_penalty = 1 if getattr(ts, "excluded_from_generation", False) else 0

                    day_load = 0
                    if subject.class_ids:
                        day_load = sum(class_day_load_units[(class_id, ts.day)] for class_id in subject.class_ids)

                    min_p, max_p = day_period_bounds.get(ts.day, (ts.period, ts.period))
                    boundary_penalty = 1 if ts.period in {min_p, max_p} else 0
                    boundary_repeat_penalty = subject_boundary_count if boundary_penalty else 0
                    first_slot_repeat_penalty = subject_first_boundary_count if ts.period == min_p else 0
                    last_slot_repeat_penalty = subject_last_boundary_count if ts.period == max_p else 0

                    class_week_balance_penalty = 0
                    if target_class_units and subject.class_ids:
                        for class_id in subject.class_ids:
                            target_units = target_class_units.get(class_id)
                            if target_units is None:
                                continue
                            before = abs(class_week_units.get(class_id, 0) - target_units)
                            after = abs((class_week_units.get(class_id, 0) + units_for_placement) - target_units)
                            # Prefer placements that move this class closer to its A/B target.
                            class_week_balance_penalty += max(0, after - before)

                    norsk_pair_penalty = 0
                    norsk_pair_setup_penalty = 0
                    if is_norsk_vg3 and not _has_norsk_target_pair():
                        day_periods = subject_periods_by_day.get(ts.day, set())
                        completes_target_pair = (
                            (ts.period == 1 and 2 in day_periods)
                            or (ts.period == 2 and 1 in day_periods)
                            or (ts.period == 3 and 4 in day_periods)
                            or (ts.period == 4 and 3 in day_periods)
                        )
                        norsk_pair_penalty = 0 if completes_target_pair else 1
                        norsk_pair_setup_penalty = 0 if ts.period in {1, 2, 3, 4} else 1

                    score = (
                        would_overshoot,
                        norsk_pair_penalty,
                        norsk_pair_setup_penalty,
                        same_day_repeat_penalty,
                        thursday_math_penalty,
                        single_unit_penalty,
                        odd_tail_priority_penalty,
                        exact_fit_penalty,
                        class_week_balance_penalty,
                        cross_week_pair_penalty,
                        excluded_slot_penalty,
                        first_slot_repeat_penalty,
                        last_slot_repeat_penalty,
                        boundary_penalty,
                        boundary_repeat_penalty,
                        day_load,
                        ts.day,
                        ts.period,
                    )
                    feasible_candidates.append((score, ts_id, custom_start, custom_end, units_for_placement))

                if feasible_candidates:
                    break

            if not feasible_candidates:
                if _try_relocate_conflict_for_sports(candidate_slots, enforce_unique_day):
                    relocation_attempts_used += 1
                    continue
                if enforce_unique_day:
                    # If strict one-per-day placement gets stuck, relax for this subject.
                    # same_day_repeat_penalty keeps this as a fallback preference.
                    enforce_unique_day = False
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
                    week_type=week_label,
                    room_id=subject_to_room.get(subject.id),
                )
            )

            for class_id in subject.class_ids:
                class_occupied.add((class_id, chosen_ts_id))
                class_day_load_units[(class_id, chosen_ts.day)] += chosen_units
                class_week_units[class_id] += chosen_units
            for teacher_id in teacher_ids:
                teacher_occupied.add((teacher_id, chosen_ts_id))
            _increment_room_slot_usage(subject.id, chosen_ts_id, planning_week_key)

            subject_days_used.add(chosen_ts.day)
            subject_periods_by_day[chosen_ts.day].add(chosen_ts.period)
            if _is_boundary_period(chosen_ts.day, chosen_ts.period):
                subject_boundary_count += 1
            chosen_min_p, chosen_max_p = day_period_bounds.get(chosen_ts.day, (chosen_ts.period, chosen_ts.period))
            if chosen_ts.period == chosen_min_p:
                subject_first_boundary_count += 1
            if chosen_ts.period == chosen_max_p:
                subject_last_boundary_count += 1
            units_placed += chosen_units

        if (
            units_placed < required_units
            and not allow_partial_remaining
            and subject.id not in partial_subject_ids
        ):
            feasible_capacity_now = 0
            feasible_capacity_without_room = 0
            room_blocked_slot_count = 0
            for ts_id in candidate_slots:
                if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                    continue
                if any((class_id, ts_id) in class_occupied for class_id in subject.class_ids):
                    continue

                slot_units = timeslot_units_by_id.get(ts_id, 1)
                feasible_capacity_without_room += slot_units
                if not _room_capacity_available(subject, ts_id, planning_week_key):
                    room_blocked_slot_count += 1
                    continue
                feasible_capacity_now += slot_units

            room_reason = ""
            if feasible_capacity_without_room > 0 and feasible_capacity_now == 0:
                room_type_label = "Idrettshaller" if subject.id in sports_only_subject_ids else "rom"
                room_reason = (
                    f" No compatible {room_type_label} available in {room_blocked_slot_count} otherwise free allowed slot(s)."
                )

            return _partial_infeasible_response(
                f"No valid schedule found for remaining subject '{subject.name}' ({subject.id}). "
                f"Required {required_units}u, placed {units_placed}u. "
                f"Current free capacity {feasible_capacity_now}u across allowed slots.{room_reason}"
            )

        if subject.id in partial_subject_ids:
            min_partial_units = max(0, int(partial_min_units.get(subject.id, 0)))

            # Partial A/B balancing should only enforce a minimum that is
            # actually reachable given current A-week occupancy constraints.
            feasible_capacity_now = 0
            for ts_id in candidate_slots:
                if not _room_capacity_available(subject, ts_id, planning_week_key):
                    continue
                if any((teacher_id, ts_id) in teacher_occupied for teacher_id in teacher_ids):
                    continue
                if any((class_id, ts_id) in class_occupied for class_id in subject.class_ids):
                    continue

                reduced_spans_now = {
                    reduced_tail_span_by_class_slot[(class_id, ts_id)]
                    for class_id in subject.class_ids
                    if (class_id, ts_id) in reduced_tail_span_by_class_slot
                }
                has_partial_tail_now = len(reduced_spans_now) > 0
                if has_partial_tail_now:
                    all_classes_in_tail_now = len(subject.class_ids) == sum(
                        1 for class_id in subject.class_ids if (class_id, ts_id) in reduced_tail_span_by_class_slot
                    )
                    if not all_classes_in_tail_now:
                        continue
                    if not subject_requires_odd_units:
                        continue
                    feasible_capacity_now += 1
                    continue

                feasible_capacity_now += timeslot_units_by_id.get(ts_id, 1)

            effective_min_partial_units = min(
                min_partial_units,
                max(0, required_units),
                max(0, feasible_capacity_now),
            )

            if units_placed < effective_min_partial_units:
                return _partial_infeasible_response(
                    f"No valid schedule found for remaining subject '{subject.name}' ({subject.id}) "
                    f"to satisfy minimum A/B balancing load. Required at least {effective_min_partial_units}u "
                    f"(requested {min_partial_units}u), placed {units_placed}u."
                )

    return ScheduleResponse(
        status="success",
        message="Schedule generated with staged planner (blocks -> meetings -> remaining subjects).",
        schedule=schedule_items,
    )


def _item_units(item: ScheduledItem, timeslot_units_map: Dict[str, int]) -> int:
    """Return the 45-minute unit count actually consumed by a scheduled item."""
    if item.start_time and item.end_time:
        start = _to_minutes(item.start_time)
        end = _to_minutes(item.end_time)
        if start is not None and end is not None and end > start:
            return max(1, int(round((end - start) / 45.0)))
    return timeslot_units_map.get(item.timeslot_id, 1)


def _scheduled_item_teacher_ids(item: ScheduledItem) -> List[str]:
    teacher_ids: List[str] = []
    if item.teacher_id:
        teacher_ids.append(item.teacher_id)
    teacher_ids.extend(item.teacher_ids or [])
    return list(dict.fromkeys([t for t in teacher_ids if t]))


def _is_norsk_vg3_subject(subject: Subject | None) -> bool:
    if not subject:
        return False
    normalized_name = " ".join((subject.name or "").lower().split())
    return "norsk vg3" in normalized_name or ("norsk" in normalized_name and "vg3" in normalized_name)


def _subject_day_repeat_penalty(
    items: List[ScheduledItem],
    subjects_by_id: Dict[str, Subject],
) -> int:
    counts: Dict[Tuple[str, str], int] = defaultdict(int)
    for item in items:
        subject = subjects_by_id.get(item.subject_id)
        if _is_norsk_vg3_subject(subject):
            continue
        if subject and subject.force_place and (subject.force_timeslot_id or "").strip():
            continue
        counts[(item.subject_id, item.day)] += 1

    penalty = 0
    for c in counts.values():
        if c > 1:
            penalty += c - 1
    return penalty


def _has_opposite_week_pair(
    item: ScheduledItem,
    schedule_items: List[ScheduledItem],
    exclude_indices: Set[int] | None = None,
) -> bool:
    exclude = exclude_indices or set()
    week = item.week_type or "base"
    if week not in {"A", "B"}:
        return False
    opposite_week = "B" if week == "A" else "A"
    class_ids = set(item.class_ids)

    for idx, other in enumerate(schedule_items):
        if idx in exclude:
            continue
        if other.subject_id != item.subject_id:
            continue
        if (other.week_type or "base") != opposite_week:
            continue
        if other.timeslot_id != item.timeslot_id:
            continue
        if other.day != item.day or other.period != item.period:
            continue
        if set(other.class_ids) != class_ids:
            continue
        return True
    return False


def _find_opposite_week_pair_index(
    item: ScheduledItem,
    schedule_items: List[ScheduledItem],
    exclude_indices: Set[int] | None = None,
) -> int | None:
    exclude = exclude_indices or set()
    week = item.week_type or "base"
    if week not in {"A", "B"}:
        return None
    opposite_week = "B" if week == "A" else "A"
    class_ids = set(item.class_ids)

    for idx, other in enumerate(schedule_items):
        if idx in exclude:
            continue
        if other.subject_id != item.subject_id:
            continue
        if (other.week_type or "base") != opposite_week:
            continue
        if other.timeslot_id != item.timeslot_id:
            continue
        if other.day != item.day or other.period != item.period:
            continue
        if set(other.class_ids) != class_ids:
            continue
        return idx

    return None


def _norsk_vg3_adjacent_double90_pairs(
    items: List[ScheduledItem],
    subjects_by_id: Dict[str, Subject],
    timeslots_by_id: Dict[str, Timeslot],
    timeslot_units_map: Dict[str, int],
) -> int:
    by_subject_week_day: Dict[Tuple[str, str, str], List[ScheduledItem]] = defaultdict(list)
    for item in items:
        subject = subjects_by_id.get(item.subject_id)
        if not _is_norsk_vg3_subject(subject):
            continue
        if _item_units(item, timeslot_units_map) < 2:
            continue
        week = item.week_type or "base"
        by_subject_week_day[(item.subject_id, week, item.day)].append(item)

    noon = 12 * 60
    pairs = 0
    for grouped_items in by_subject_week_day.values():
        resolved: List[Tuple[int, int]] = []
        for item in grouped_items:
            start = _to_minutes(item.start_time) if item.start_time else None
            end = _to_minutes(item.end_time) if item.end_time else None
            if start is None or end is None:
                ts = timeslots_by_id.get(item.timeslot_id)
                if ts:
                    start, end = _timeslot_bounds_minutes(ts)
            if start is None or end is None or end <= start:
                continue
            resolved.append((start, end))

        resolved.sort()
        for i in range(len(resolved) - 1):
            start_a, end_a = resolved[i]
            start_b, end_b = resolved[i + 1]
            contiguous = end_a == start_b
            same_half_day = (end_a <= noon and end_b <= noon) or (start_a >= noon and start_b >= noon)
            if contiguous and same_half_day:
                pairs += 1
                break

    return pairs


def _odd_subject_unmatched_split_penalty(
    items: List[ScheduledItem],
    subjects_by_id: Dict[str, Subject],
) -> int:
    by_subject: Dict[str, List[ScheduledItem]] = defaultdict(list)
    for item in items:
        by_subject[item.subject_id].append(item)

    penalty = 0
    for subject_id, subject_items in by_subject.items():
        subject = subjects_by_id.get(subject_id)
        if not subject:
            continue
        if _is_norsk_vg3_subject(subject):
            continue
        if getattr(subject, "force_place", False):
            continue
        if int(subject.sessions_per_week or 1) % 2 == 0:
            continue

        a_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        b_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        for item in subject_items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            sig = (item.timeslot_id, item.day, item.period, item.start_time, item.end_time)
            if week == "A":
                a_counts[sig] += 1
            else:
                b_counts[sig] += 1

        matched = 0
        for sig in set(a_counts.keys()) | set(b_counts.keys()):
            matched += min(a_counts.get(sig, 0), b_counts.get(sig, 0))

        total_ab_items = sum(a_counts.values()) + sum(b_counts.values())
        unmatched = total_ab_items - 2 * matched
        if unmatched > 1:
            penalty += unmatched - 1

    return penalty


def _ab_signature_mismatch_penalty(
    items: List[ScheduledItem],
    subjects_by_id: Dict[str, Subject],
) -> int:
    """
    Penalize subject placements that do not line up between A/B weeks.
    For odd-unit subjects one unmatched signature is acceptable; for even-unit
    subjects we prefer full A/B signature alignment.
    """
    by_subject: Dict[str, List[ScheduledItem]] = defaultdict(list)
    for item in items:
        by_subject[item.subject_id].append(item)

    penalty = 0
    for subject_id, subject_items in by_subject.items():
        subject = subjects_by_id.get(subject_id)
        if not subject:
            continue
        if getattr(subject, "force_place", False):
            continue

        a_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        b_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        for item in subject_items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            sig = (item.timeslot_id, item.day, item.period, item.start_time, item.end_time)
            if week == "A":
                a_counts[sig] += 1
            else:
                b_counts[sig] += 1

        matched = 0
        for sig in set(a_counts.keys()) | set(b_counts.keys()):
            matched += min(a_counts.get(sig, 0), b_counts.get(sig, 0))

        total_ab_items = sum(a_counts.values()) + sum(b_counts.values())
        unmatched = total_ab_items - 2 * matched

        allowed_unmatched = 1 if (int(subject.sessions_per_week or 1) % 2 == 1) else 0
        if unmatched > allowed_unmatched:
            penalty += unmatched - allowed_unmatched

    return penalty


def _odd_subject_two_sided_split_penalty(
    items: List[ScheduledItem],
    subjects_by_id: Dict[str, Subject],
) -> int:
    """
    Penalize odd-unit subjects that keep unmatched signatures in BOTH A and B.
    Preferred odd pattern is one-sided split (e.g. shared+shared+A-only OR shared+shared+B-only),
    not dual-sided split (shared+shared+A-only+B-only).
    """
    by_subject: Dict[str, List[ScheduledItem]] = defaultdict(list)
    for item in items:
        by_subject[item.subject_id].append(item)

    penalty = 0
    for subject_id, subject_items in by_subject.items():
        subject = subjects_by_id.get(subject_id)
        if not subject:
            continue
        if getattr(subject, "force_place", False):
            continue
        if int(subject.sessions_per_week or 1) % 2 == 0:
            continue

        a_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        b_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        for item in subject_items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            sig = (item.timeslot_id, item.day, item.period, item.start_time, item.end_time)
            if week == "A":
                a_counts[sig] += 1
            else:
                b_counts[sig] += 1

        unmatched_a = 0
        unmatched_b = 0
        for sig in set(a_counts.keys()) | set(b_counts.keys()):
            a_val = a_counts.get(sig, 0)
            b_val = b_counts.get(sig, 0)
            if a_val > b_val:
                unmatched_a += a_val - b_val
            elif b_val > a_val:
                unmatched_b += b_val - a_val

        if unmatched_a > 0 and unmatched_b > 0:
            penalty += min(unmatched_a, unmatched_b)

    return penalty


def _reduced_tail_ab_mismatch_penalty(
    items: List[ScheduledItem],
    timeslot_units_map: Dict[str, int],
) -> int:
    """Penalize reduced-tail 45-minute placements that appear in only one of A/B."""
    a_counts: Dict[Tuple[str, str, str, str, str], int] = defaultdict(int)
    b_counts: Dict[Tuple[str, str, str, str, str], int] = defaultdict(int)

    for item in items:
        week = item.week_type or "base"
        if week not in {"A", "B"}:
            continue
        if not (item.start_time and item.end_time):
            continue
        if _item_units(item, timeslot_units_map) != 1:
            continue

        sig = (
            item.subject_id,
            item.timeslot_id,
            item.day,
            item.start_time,
            item.end_time,
        )
        if week == "A":
            a_counts[sig] += 1
        else:
            b_counts[sig] += 1

    penalty = 0
    for sig in set(a_counts.keys()) | set(b_counts.keys()):
        penalty += abs(a_counts.get(sig, 0) - b_counts.get(sig, 0))

    return penalty


def _move_item_to_slot(item: ScheduledItem, target_slot: Timeslot) -> ScheduledItem:
    return ScheduledItem(
        subject_id=item.subject_id,
        subject_name=item.subject_name,
        teacher_id=item.teacher_id,
        teacher_ids=item.teacher_ids,
        class_ids=item.class_ids,
        timeslot_id=target_slot.id,
        day=target_slot.day,
        period=target_slot.period,
        # Reset custom span when moving to a different slot.
        start_time=None,
        end_time=None,
        week_type=item.week_type,
        room_id=item.room_id,
    )


def _can_place_item_in_slot(
    item: ScheduledItem,
    target_slot_id: str,
    target_week: str,
    schedule_items: List[ScheduledItem],
    exclude_indices: Set[int],
    allowed_slots_by_subject: Dict[str, Set[str]],
    allowed_weeks_by_subject: Dict[str, Set[str]],
    teacher_unavailable: Dict[str, Set[str]],
    blocked_class_slots_by_week: Dict[Tuple[str, str], Set[str]],
) -> bool:
    if target_slot_id not in allowed_slots_by_subject.get(item.subject_id, set()):
        return False
    if target_week not in allowed_weeks_by_subject.get(item.subject_id, {target_week}):
        return False

    for class_id in item.class_ids:
        if target_slot_id in blocked_class_slots_by_week.get((class_id, target_week), set()):
            return False

    item_teacher_ids = _scheduled_item_teacher_ids(item)
    for teacher_id in item_teacher_ids:
        if target_slot_id in teacher_unavailable.get(teacher_id, set()):
            return False

    for idx, other in enumerate(schedule_items):
        if idx in exclude_indices:
            continue
        other_week = other.week_type or "base"
        if other_week != target_week:
            continue
        if other.timeslot_id != target_slot_id:
            continue

        if set(item.class_ids).intersection(other.class_ids):
            return False

        other_teacher_ids = set(_scheduled_item_teacher_ids(other))
        if any(tid in other_teacher_ids for tid in item_teacher_ids):
            return False

    return True


def _post_optimize_ab_day_uniqueness(
    data: ScheduleRequest,
    schedule_items: List[ScheduledItem],
    timeslot_units_map: Dict[str, int],
) -> List[ScheduledItem]:
    if not data.alternating_weeks_enabled or not schedule_items:
        return schedule_items

    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    all_timeslot_ids: Set[str] = set(timeslots_by_id.keys())
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}
    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
        block_to_timeslots[block.id] = slot_set

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for se in block.subject_entries:
            linked_block_ids[se.subject_id].add(block.id)
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)
    block_subject_ids: Set[str] = set(linked_block_ids.keys())

    allowed_slots_by_subject: Dict[str, Set[str]] = {}
    allowed_weeks_by_subject: Dict[str, Set[str]] = {}
    for subject in data.subjects:
        allowed_slots_by_subject[subject.id] = _compute_allowed_timeslots(
            subject,
            all_timeslot_ids,
            block_to_timeslots,
            timeslots_by_id,
        )
        allowed_weeks_by_subject[subject.id] = _compute_allowed_weeks(
            subject,
            True,
            blocks_by_id,
            linked_block_ids,
        )

    teacher_unavailable: Dict[str, Set[str]] = defaultdict(set)
    for teacher in data.teachers:
        teacher_unavailable[teacher.id] |= set(teacher.unavailable_timeslots)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.mode == "unavailable":
                teacher_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    blocked_class_slots_by_week: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    for block in data.blocks:
        if not block.class_ids:
            continue
        if block.occurrences:
            for occ in block.occurrences:
                matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids
                occ_week = (occ.week_type or "both").upper()
                target_weeks = ["A", "B"] if occ_week == "BOTH" else [occ_week]
                for class_id in block.class_ids:
                    for week in target_weeks:
                        blocked_class_slots_by_week[(class_id, week)].update(matched_slots)
        else:
            legacy_weeks = _block_active_weeks(block, True)
            for class_id in block.class_ids:
                for week in legacy_weeks:
                    blocked_class_slots_by_week[(class_id, week)].update(set(block.timeslot_ids) & all_timeslot_ids)

    def _score(items: List[ScheduledItem]) -> int:
        repeat_penalty = _subject_day_repeat_penalty(items, subjects_by_id)
        odd_split_penalty = _odd_subject_unmatched_split_penalty(items, subjects_by_id)
        odd_two_sided_penalty = _odd_subject_two_sided_split_penalty(items, subjects_by_id)
        ab_mismatch_penalty = _ab_signature_mismatch_penalty(items, subjects_by_id)
        reduced_tail_mismatch_penalty = _reduced_tail_ab_mismatch_penalty(items, timeslot_units_map)
        norsk_pairs = _norsk_vg3_adjacent_double90_pairs(items, subjects_by_id, timeslots_by_id, timeslot_units_map)
        # Strongly prioritize:
        # 1. odd subjects splitting only once across A/B,
        # 2. keeping reduced-tail 45m placements mirrored across A/B,
        # 3. improving generic A/B slot alignment (also for even subjects),
        # 4. removing duplicate same-day subject placements,
        # 5. Norsk vg3 adjacency as a secondary preference.
        return (
            odd_two_sided_penalty * 2400
            + odd_split_penalty * 1400
            + reduced_tail_mismatch_penalty * 700
            + ab_mismatch_penalty * 1200
            + repeat_penalty * 220
            - norsk_pairs * 450
        )

    def _slot_sort_key(ts_id: str) -> Tuple[str, int]:
        ts = timeslots_by_id[ts_id]
        return (ts.day, ts.period)

    def _item_signature(item: ScheduledItem) -> Tuple[str, str, int, str | None, str | None]:
        return (item.timeslot_id, item.day, item.period, item.start_time, item.end_time)

    def _unmatched_indices_for_subject(
        items: List[ScheduledItem],
        subject_id: str,
        week: str,
    ) -> List[int]:
        if week not in {"A", "B"}:
            return []
        opposite_week = "B" if week == "A" else "A"

        a_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        b_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
        indices_by_sig: Dict[Tuple[str, str, int, str | None, str | None], List[int]] = defaultdict(list)

        for idx, item in enumerate(items):
            if item.subject_id != subject_id:
                continue
            item_week = item.week_type or "base"
            if item_week not in {"A", "B"}:
                continue
            sig = _item_signature(item)
            if item_week == "A":
                a_counts[sig] += 1
            else:
                b_counts[sig] += 1
            if item_week == week:
                indices_by_sig[sig].append(idx)

        unmatched: List[int] = []
        for sig, idxs in indices_by_sig.items():
            primary = a_counts.get(sig, 0) if week == "A" else b_counts.get(sig, 0)
            opposite = b_counts.get(sig, 0) if week == "A" else a_counts.get(sig, 0)
            extra = max(0, primary - opposite)
            if extra > 0:
                unmatched.extend(idxs[:extra])

        unmatched.sort(key=lambda idx: (items[idx].day, items[idx].period, items[idx].timeslot_id))
        return unmatched

    working_items = list(schedule_items)
    best_score = _score(working_items)

    ordered_slots = sorted(all_timeslot_ids, key=_slot_sort_key)

    max_iterations = 80
    for _ in range(max_iterations):
        counts: Dict[Tuple[str, str], List[int]] = defaultdict(list)
        for idx, item in enumerate(working_items):
            subject = subjects_by_id.get(item.subject_id)
            if _is_norsk_vg3_subject(subject):
                continue
            if subject and subject.force_place and (subject.force_timeslot_id or "").strip():
                continue
            counts[(item.subject_id, item.day)].append(idx)

        conflict_indices: List[int] = []
        for grouped in counts.values():
            if len(grouped) > 1:
                conflict_indices.extend(grouped)
        if not conflict_indices:
            break

        improved = False
        for idx_a in conflict_indices:
            item_a = working_items[idx_a]
            week_a = item_a.week_type or "base"

            # Focus this pass on 90-minute swaps as requested.
            units_a = _item_units(item_a, timeslot_units_map)
            if units_a < 2:
                continue
            if item_a.subject_id in block_subject_ids:
                continue
            if item_a.start_time or item_a.end_time:
                continue
            pair_a_idx = _find_opposite_week_pair_index(item_a, working_items, {idx_a})
            pair_a_item = working_items[pair_a_idx] if pair_a_idx is not None else None

            subject_a = subjects_by_id.get(item_a.subject_id)
            if not subject_a:
                continue
            if subject_a.force_place and (subject_a.force_timeslot_id or "").strip():
                continue

            subject_a_days_all_weeks = {
                it.day
                for it in working_items
                if it.subject_id == item_a.subject_id
            }

            # First, try relocating directly to an empty valid slot on a different day.
            for target_ts_id in ordered_slots:
                target_ts = timeslots_by_id[target_ts_id]
                if target_ts.day == item_a.day:
                    continue
                if target_ts.day in subject_a_days_all_weeks:
                    continue
                if timeslot_units_map.get(target_ts_id, 1) != units_a:
                    continue

                exclusions = {idx_a}
                can_place_a = _can_place_item_in_slot(
                    item_a,
                    target_ts_id,
                    week_a,
                    working_items,
                    exclusions,
                    allowed_slots_by_subject,
                    allowed_weeks_by_subject,
                    teacher_unavailable,
                    blocked_class_slots_by_week,
                )
                if not can_place_a:
                    continue

                candidate = list(working_items)
                candidate[idx_a] = _move_item_to_slot(item_a, target_ts)

                if pair_a_item is not None and pair_a_idx is not None:
                    pair_week = pair_a_item.week_type or "base"
                    pair_exclusions = {idx_a, pair_a_idx}
                    can_place_pair = _can_place_item_in_slot(
                        pair_a_item,
                        target_ts_id,
                        pair_week,
                        working_items,
                        pair_exclusions,
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    )
                    if not can_place_pair:
                        continue
                    candidate[pair_a_idx] = _move_item_to_slot(pair_a_item, target_ts)

                candidate_score = _score(candidate)
                if candidate_score < best_score:
                    working_items = candidate
                    best_score = candidate_score
                    improved = True
                    break

            if improved:
                break

            for idx_b, item_b in enumerate(working_items):
                if idx_b == idx_a:
                    continue
                week_b = item_b.week_type or "base"
                if week_b != week_a:
                    continue
                if item_b.subject_id == item_a.subject_id:
                    continue
                if item_b.subject_id in block_subject_ids:
                    continue
                if item_b.start_time or item_b.end_time:
                    continue
                if set(item_b.class_ids) != set(item_a.class_ids):
                    # Swaps should stay within the same class scope.
                    continue

                subject_b = subjects_by_id.get(item_b.subject_id)
                if subject_b and subject_b.force_place and (subject_b.force_timeslot_id or "").strip():
                    continue

                pair_b_idx = _find_opposite_week_pair_index(item_b, working_items, {idx_b})
                pair_b_item = working_items[pair_b_idx] if pair_b_idx is not None else None

                # Only do pair-preserving swaps: either both are paired or both are unpaired.
                if (pair_a_item is None) != (pair_b_item is None):
                    continue

                units_b = _item_units(item_b, timeslot_units_map)
                if units_b != units_a:
                    continue

                subject_b_days_all_weeks = {
                    it.day
                    for it in working_items
                    if it.subject_id == item_b.subject_id
                }

                target_ts_for_a = item_b.timeslot_id
                target_ts_for_b = item_a.timeslot_id
                target_day_for_a = item_b.day
                if target_day_for_a == item_a.day:
                    continue
                if target_day_for_a in subject_a_days_all_weeks and target_day_for_a != item_a.day:
                    continue
                target_day_for_b = item_a.day
                if target_day_for_b in subject_b_days_all_weeks and target_day_for_b != item_b.day:
                    continue

                if not _can_place_item_in_slot(
                    item_a,
                    target_ts_for_a,
                    week_a,
                    working_items,
                    {idx_a, idx_b},
                    allowed_slots_by_subject,
                    allowed_weeks_by_subject,
                    teacher_unavailable,
                    blocked_class_slots_by_week,
                ):
                    continue

                if not _can_place_item_in_slot(
                    item_b,
                    target_ts_for_b,
                    week_a,
                    working_items,
                    {idx_a, idx_b},
                    allowed_slots_by_subject,
                    allowed_weeks_by_subject,
                    teacher_unavailable,
                    blocked_class_slots_by_week,
                ):
                    continue

                target_slot_for_a = timeslots_by_id.get(target_ts_for_a)
                target_slot_for_b = timeslots_by_id.get(target_ts_for_b)
                if not target_slot_for_a or not target_slot_for_b:
                    continue

                candidate = list(working_items)
                candidate[idx_a] = _move_item_to_slot(item_a, target_slot_for_a)
                candidate[idx_b] = _move_item_to_slot(item_b, target_slot_for_b)

                if pair_a_item is not None and pair_a_idx is not None and pair_b_item is not None and pair_b_idx is not None:
                    pair_target_week_a = pair_a_item.week_type or "base"
                    pair_target_week_b = pair_b_item.week_type or "base"

                    if not _can_place_item_in_slot(
                        pair_a_item,
                        target_ts_for_a,
                        pair_target_week_a,
                        working_items,
                        {idx_a, idx_b, pair_a_idx, pair_b_idx},
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    ):
                        continue
                    if not _can_place_item_in_slot(
                        pair_b_item,
                        target_ts_for_b,
                        pair_target_week_b,
                        working_items,
                        {idx_a, idx_b, pair_a_idx, pair_b_idx},
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    ):
                        continue

                    candidate[pair_a_idx] = _move_item_to_slot(pair_a_item, target_slot_for_a)
                    candidate[pair_b_idx] = _move_item_to_slot(pair_b_item, target_slot_for_b)

                candidate_score = _score(candidate)
                if candidate_score < best_score:
                    working_items = candidate
                    best_score = candidate_score
                    improved = True
                    break

            if improved:
                break

        if not improved:
            break

    # Stage 2: chain-style subject rebalance.
    # Convert a B-only slot into a both-weeks slot by adding A there,
    # then remove another unmatched B slot for the same subject.
    # If A at the promoted slot is occupied, try a 2-step chain by moving
    # that A occupant into the removable B slot before finalizing.
    rebalance_subject_ids = [
        s.id
        for s in data.subjects
        if not _is_norsk_vg3_subject(s)
        and not (getattr(s, "force_place", False) and (getattr(s, "force_timeslot_id", "") or "").strip())
        and s.id not in block_subject_ids
    ]

    for _ in range(60):
        improved = False
        for subject_id in rebalance_subject_ids:
            unmatched_b = _unmatched_indices_for_subject(working_items, subject_id, "B")
            if len(unmatched_b) <= 1:
                continue

            for promote_idx in unmatched_b:
                promote_item_b = working_items[promote_idx]

                promoted_item_a = ScheduledItem(
                    subject_id=promote_item_b.subject_id,
                    subject_name=promote_item_b.subject_name,
                    teacher_id=promote_item_b.teacher_id,
                    teacher_ids=promote_item_b.teacher_ids,
                    class_ids=promote_item_b.class_ids,
                    timeslot_id=promote_item_b.timeslot_id,
                    day=promote_item_b.day,
                    period=promote_item_b.period,
                    start_time=promote_item_b.start_time,
                    end_time=promote_item_b.end_time,
                    week_type="A",
                    room_id=promote_item_b.room_id,
                )

                for remove_idx in unmatched_b:
                    if remove_idx == promote_idx:
                        continue
                    remove_item_b = working_items[remove_idx]

                    if _item_units(promote_item_b, timeslot_units_map) != _item_units(remove_item_b, timeslot_units_map):
                        continue

                    direct_ok = _can_place_item_in_slot(
                        promoted_item_a,
                        promote_item_b.timeslot_id,
                        "A",
                        working_items,
                        {promote_idx, remove_idx},
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    )

                    candidate: List[ScheduledItem] | None = None
                    if direct_ok:
                        candidate = [item for idx, item in enumerate(working_items) if idx != remove_idx]
                        candidate.append(promoted_item_a)
                    else:
                        conflict_indices = [
                            idx
                            for idx, item in enumerate(working_items)
                            if (item.week_type or "base") == "A"
                            and item.timeslot_id == promote_item_b.timeslot_id
                            and bool(set(item.class_ids).intersection(promote_item_b.class_ids))
                        ]
                        if len(conflict_indices) != 1:
                            continue

                        conflict_idx = conflict_indices[0]
                        conflict_item_a = working_items[conflict_idx]
                        if conflict_item_a.start_time or conflict_item_a.end_time:
                            continue

                        target_slot_for_conflict = remove_item_b.timeslot_id
                        move_conflict_ok = _can_place_item_in_slot(
                            conflict_item_a,
                            target_slot_for_conflict,
                            "A",
                            working_items,
                            {promote_idx, remove_idx, conflict_idx},
                            allowed_slots_by_subject,
                            allowed_weeks_by_subject,
                            teacher_unavailable,
                            blocked_class_slots_by_week,
                        )
                        if not move_conflict_ok:
                            continue

                        moved_conflict = _move_item_to_slot(conflict_item_a, timeslots_by_id[target_slot_for_conflict])
                        candidate = []
                        for idx, item in enumerate(working_items):
                            if idx == remove_idx:
                                continue
                            if idx == conflict_idx:
                                candidate.append(moved_conflict)
                            else:
                                candidate.append(item)
                        candidate.append(promoted_item_a)

                    if candidate is None:
                        continue

                    candidate_score = _score(candidate)
                    if candidate_score < best_score:
                        working_items = candidate
                        best_score = candidate_score
                        improved = True
                        break

                if improved:
                    break

            if improved:
                break

        if not improved:
            break

    # Stage 2c: Norsk vg3 adjacency improvement.
    # When Norsk vg3 appears twice on the same day in a week, prefer contiguous
    # placement (typically periods 1+2 or 3+4) and try a local swap if needed.
    slot_id_by_day_period: Dict[Tuple[str, int], str] = {
        (ts.day, ts.period): ts.id for ts in timeslots_by_id.values()
    }

    def _norsk_non_adjacent_penalty(items: List[ScheduledItem]) -> int:
        penalty = 0
        norsk_subject_ids = {
            s.id
            for s in data.subjects
            if _is_norsk_vg3_subject(s)
            and s.id not in block_subject_ids
            and not (getattr(s, "force_place", False) and (getattr(s, "force_timeslot_id", "") or "").strip())
        }
        for subject_id in norsk_subject_ids:
            for week_key in ["A", "B"]:
                by_day: Dict[str, List[int]] = defaultdict(list)
                for item in items:
                    if item.subject_id != subject_id:
                        continue
                    if (item.week_type or "base") != week_key:
                        continue
                    by_day[item.day].append(item.period)
                for periods in by_day.values():
                    if len(periods) < 2:
                        continue
                    periods = sorted(periods)
                    has_adjacent = any((periods[i + 1] - periods[i]) == 1 for i in range(len(periods) - 1))
                    if not has_adjacent:
                        penalty += 1
        return penalty

    for _ in range(24):
        improved = False
        current_norsk_penalty = _norsk_non_adjacent_penalty(working_items)
        for subject in data.subjects:
            if not _is_norsk_vg3_subject(subject):
                continue
            if subject.id in block_subject_ids:
                continue
            if getattr(subject, "force_place", False) and (getattr(subject, "force_timeslot_id", "") or "").strip():
                continue

            for week_key in ["A", "B"]:
                subject_items = [
                    (idx, item)
                    for idx, item in enumerate(working_items)
                    if item.subject_id == subject.id
                    and (item.week_type or "base") == week_key
                    and not (item.start_time or item.end_time)
                ]
                if len(subject_items) < 2:
                    continue

                by_day: Dict[str, List[Tuple[int, ScheduledItem]]] = defaultdict(list)
                for idx, item in subject_items:
                    by_day[item.day].append((idx, item))

                for day, day_items in by_day.items():
                    if len(day_items) < 2:
                        continue

                    periods = sorted(item.period for _, item in day_items)
                    has_adjacent = any((periods[i + 1] - periods[i]) == 1 for i in range(len(periods) - 1))
                    if has_adjacent:
                        continue

                    prefer_first_half = any(period <= 2 for period in periods)
                    target_pairs = [(1, 2), (3, 4)] if prefer_first_half else [(3, 4), (1, 2)]

                    for p1, p2 in target_pairs:
                        s1 = slot_id_by_day_period.get((day, p1))
                        s2 = slot_id_by_day_period.get((day, p2))
                        if not s1 or not s2:
                            continue

                        subject_slots_today = {item.timeslot_id for _, item in day_items}
                        if s1 in subject_slots_today and s2 in subject_slots_today:
                            continue

                        missing_target = s1 if s1 not in subject_slots_today else s2

                        move_candidates = [
                            (idx, item)
                            for idx, item in subject_items
                            if item.day == day
                            if item.timeslot_id != missing_target
                        ]
                        move_candidates.sort(key=lambda pair: pair[1].period)

                        for move_idx, move_item in move_candidates:
                            if move_item.timeslot_id == missing_target:
                                continue

                            exclusions = {move_idx}
                            can_direct = _can_place_item_in_slot(
                                move_item,
                                missing_target,
                                week_key,
                                working_items,
                                exclusions,
                                allowed_slots_by_subject,
                                allowed_weeks_by_subject,
                                teacher_unavailable,
                                blocked_class_slots_by_week,
                            )

                            candidate: List[ScheduledItem] | None = None
                            target_slot = timeslots_by_id.get(missing_target)
                            if not target_slot:
                                continue

                            if can_direct:
                                candidate = list(working_items)
                                candidate[move_idx] = _move_item_to_slot(move_item, target_slot)
                            else:
                                blocking_indices = [
                                    idx
                                    for idx, item in enumerate(working_items)
                                    if idx != move_idx
                                    and (item.week_type or "base") == week_key
                                    and item.timeslot_id == missing_target
                                    and bool(set(item.class_ids).intersection(move_item.class_ids))
                                ]
                                if len(blocking_indices) != 1:
                                    continue
                                block_idx = blocking_indices[0]
                                blocking_item = working_items[block_idx]
                                blocking_subject = subjects_by_id.get(blocking_item.subject_id)
                                if not blocking_subject:
                                    continue
                                if blocking_item.start_time or blocking_item.end_time:
                                    continue
                                if blocking_item.subject_id in block_subject_ids:
                                    continue
                                if getattr(blocking_subject, "force_place", False) and (getattr(blocking_subject, "force_timeslot_id", "") or "").strip():
                                    continue
                                if _item_units(blocking_item, timeslot_units_map) != _item_units(move_item, timeslot_units_map):
                                    continue

                                can_move_blocker = _can_place_item_in_slot(
                                    blocking_item,
                                    move_item.timeslot_id,
                                    week_key,
                                    working_items,
                                    {move_idx, block_idx},
                                    allowed_slots_by_subject,
                                    allowed_weeks_by_subject,
                                    teacher_unavailable,
                                    blocked_class_slots_by_week,
                                )
                                if not can_move_blocker:
                                    continue

                                candidate = list(working_items)
                                candidate[move_idx] = _move_item_to_slot(move_item, target_slot)
                                blocker_target_slot = timeslots_by_id.get(move_item.timeslot_id)
                                if not blocker_target_slot:
                                    continue
                                candidate[block_idx] = _move_item_to_slot(blocking_item, blocker_target_slot)

                            if candidate is None:
                                continue

                            candidate_score = _score(candidate)
                            candidate_norsk_penalty = _norsk_non_adjacent_penalty(candidate)
                            if (
                                candidate_norsk_penalty < current_norsk_penalty
                                or (
                                    candidate_norsk_penalty == current_norsk_penalty
                                    and candidate_score < best_score
                                )
                            ):
                                working_items = candidate
                                best_score = candidate_score
                                current_norsk_penalty = candidate_norsk_penalty
                                improved = True
                                break

                        if improved:
                            break
                    if improved:
                        break
                if improved:
                    break
            if improved:
                break

        if not improved:
            break

    # Stage 2b: odd-subject one-to-one consolidation.
    # If a subject has exactly one A-only and one B-only signature, try to align
    # one onto the other to avoid unnecessary 4-slot fragmentation.
    odd_subject_ids = {
        s.id
        for s in data.subjects
        if int(s.sessions_per_week or 1) % 2 == 1
        and not _is_norsk_vg3_subject(s)
        and s.id not in block_subject_ids
        and not (getattr(s, "force_place", False) and (getattr(s, "force_timeslot_id", "") or "").strip())
    }

    for _ in range(50):
        improved = False
        for subject_id in sorted(odd_subject_ids):
            unmatched_a = _unmatched_indices_for_subject(working_items, subject_id, "A")
            unmatched_b = _unmatched_indices_for_subject(working_items, subject_id, "B")
            if len(unmatched_a) != 1 or len(unmatched_b) != 1:
                continue

            idx_a = unmatched_a[0]
            idx_b = unmatched_b[0]
            item_a = working_items[idx_a]
            item_b = working_items[idx_b]

            if item_a.start_time or item_a.end_time or item_b.start_time or item_b.end_time:
                continue
            if _item_units(item_a, timeslot_units_map) != _item_units(item_b, timeslot_units_map):
                continue

            candidate_configs: List[Tuple[int, str, str]] = [
                (idx_a, item_b.timeslot_id, "A"),
                (idx_b, item_a.timeslot_id, "B"),
            ]

            for move_idx, target_ts_id, target_week in candidate_configs:
                move_item = working_items[move_idx]
                if move_item.timeslot_id == target_ts_id:
                    continue

                if not _can_place_item_in_slot(
                    move_item,
                    target_ts_id,
                    target_week,
                    working_items,
                    {idx_a, idx_b},
                    allowed_slots_by_subject,
                    allowed_weeks_by_subject,
                    teacher_unavailable,
                    blocked_class_slots_by_week,
                ):
                    continue

                target_slot = timeslots_by_id.get(target_ts_id)
                if not target_slot:
                    continue

                candidate = list(working_items)
                candidate[move_idx] = _move_item_to_slot(move_item, target_slot)
                candidate_score = _score(candidate)
                if candidate_score < best_score:
                    working_items = candidate
                    best_score = candidate_score
                    improved = True
                    break

            if improved:
                break

        if not improved:
            break

    # Stage 2d: Align simple A/B pairs for subjects with exactly one placement
    # in each week. This catches cases like Kroppsoving where A/B land on
    # different slots even though direct alignment is feasible.
    def _single_pair_ab_mismatch_penalty(items: List[ScheduledItem]) -> int:
        penalty = 0
        by_subject_week: Dict[str, Dict[str, List[ScheduledItem]]] = defaultdict(lambda: defaultdict(list))
        for item in items:
            week_key = item.week_type or "base"
            if week_key not in {"A", "B"}:
                continue
            by_subject_week[item.subject_id][week_key].append(item)

        for subject_id, per_week in by_subject_week.items():
            a_items = per_week.get("A", [])
            b_items = per_week.get("B", [])
            if len(a_items) != 1 or len(b_items) != 1:
                continue
            if a_items[0].timeslot_id != b_items[0].timeslot_id:
                penalty += 1
        return penalty

    for _ in range(40):
        improved = False
        current_pair_penalty = _single_pair_ab_mismatch_penalty(working_items)

        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue
            if getattr(subject, "force_place", False) and (getattr(subject, "force_timeslot_id", "") or "").strip():
                continue

            subject_indices = [
                idx
                for idx, item in enumerate(working_items)
                if item.subject_id == subject.id and not (item.start_time or item.end_time)
            ]
            a_indices = [idx for idx in subject_indices if (working_items[idx].week_type or "base") == "A"]
            b_indices = [idx for idx in subject_indices if (working_items[idx].week_type or "base") == "B"]
            if len(a_indices) != 1 or len(b_indices) != 1:
                continue

            idx_a = a_indices[0]
            idx_b = b_indices[0]
            item_a = working_items[idx_a]
            item_b = working_items[idx_b]
            if item_a.timeslot_id == item_b.timeslot_id:
                continue
            if _item_units(item_a, timeslot_units_map) != _item_units(item_b, timeslot_units_map):
                continue

            move_options: List[Tuple[int, ScheduledItem, str, str, int]] = [
                (idx_a, item_a, "A", item_b.timeslot_id, idx_b),
                (idx_b, item_b, "B", item_a.timeslot_id, idx_a),
            ]

            for move_idx, move_item, move_week, target_ts_id, other_idx in move_options:
                if move_item.timeslot_id == target_ts_id:
                    continue

                exclusions = {move_idx, other_idx}
                can_direct = _can_place_item_in_slot(
                    move_item,
                    target_ts_id,
                    move_week,
                    working_items,
                    exclusions,
                    allowed_slots_by_subject,
                    allowed_weeks_by_subject,
                    teacher_unavailable,
                    blocked_class_slots_by_week,
                )

                candidate: List[ScheduledItem] | None = None
                target_slot = timeslots_by_id.get(target_ts_id)
                if not target_slot:
                    continue

                if can_direct:
                    candidate = list(working_items)
                    candidate[move_idx] = _move_item_to_slot(move_item, target_slot)
                else:
                    blocking_indices = [
                        idx
                        for idx, item in enumerate(working_items)
                        if idx not in exclusions
                        and (item.week_type or "base") == move_week
                        and item.timeslot_id == target_ts_id
                        and bool(set(item.class_ids).intersection(move_item.class_ids))
                    ]

                    for block_idx in blocking_indices:
                        blocking_item = working_items[block_idx]
                        blocking_subject = subjects_by_id.get(blocking_item.subject_id)
                        if not blocking_subject:
                            continue
                        if blocking_item.start_time or blocking_item.end_time:
                            continue
                        if blocking_item.subject_id in block_subject_ids:
                            continue
                        if getattr(blocking_subject, "force_place", False) and (getattr(blocking_subject, "force_timeslot_id", "") or "").strip():
                            continue
                        if _item_units(blocking_item, timeslot_units_map) != _item_units(move_item, timeslot_units_map):
                            continue

                        can_move_blocker = _can_place_item_in_slot(
                            blocking_item,
                            move_item.timeslot_id,
                            move_week,
                            working_items,
                            {move_idx, other_idx, block_idx},
                            allowed_slots_by_subject,
                            allowed_weeks_by_subject,
                            teacher_unavailable,
                            blocked_class_slots_by_week,
                        )
                        if not can_move_blocker:
                            continue

                        blocker_target_slot = timeslots_by_id.get(move_item.timeslot_id)
                        if not blocker_target_slot:
                            continue

                        candidate = list(working_items)
                        candidate[move_idx] = _move_item_to_slot(move_item, target_slot)
                        candidate[block_idx] = _move_item_to_slot(blocking_item, blocker_target_slot)
                        break

                if candidate is None:
                    continue

                candidate_score = _score(candidate)
                candidate_pair_penalty = _single_pair_ab_mismatch_penalty(candidate)
                if (
                    candidate_pair_penalty < current_pair_penalty
                    or (
                        candidate_pair_penalty == current_pair_penalty
                        and candidate_score < best_score
                    )
                ):
                    working_items = candidate
                    best_score = candidate_score
                    current_pair_penalty = candidate_pair_penalty
                    improved = True
                    break

            if improved:
                break

        if not improved:
            break

    # Stage 3: Subject consolidation - detect subjects with 3+ placements split across both weeks
    # and attempt to merge them by swapping with other subjects.
    def _get_subject_placement_summary(items: List[ScheduledItem]) -> Dict[str, Dict[str, Set[str]]]:
        """
        For each subject, track which week/timeslot combinations it appears in.
        Returns: {subject_id: {week: {timeslot_ids}}}
        """
        summary: Dict[str, Dict[str, Set[str]]] = defaultdict(lambda: defaultdict(set))
        for item in items:
            week = item.week_type or "base"
            summary[item.subject_id][week].add(item.timeslot_id)
        return summary

    subject_summary = _get_subject_placement_summary(working_items)
    subjects_to_consolidate = []
    for subject_id, week_slots in subject_summary.items():
        # Only consider subjects that appear in BOTH weeks A and B
        if "A" not in week_slots or "B" not in week_slots:
            continue
        # Only consider subjects with 3+ total placements (indicating fragmentation)
        total_placements = sum(len(slots) for slots in week_slots.values())
        if total_placements < 3:
            continue
        # Skip special subjects
        subject = subjects_by_id.get(subject_id)
        if not subject or subject.force_place or subject_id in block_subject_ids:
            continue
        subjects_to_consolidate.append(subject_id)

    # Multi-iteration consolidation pass
    for consolidation_round in range(30):
        consolidation_improved = False

        for subject_id in subjects_to_consolidate:
            if consolidation_improved:
                break

            # Get all items for this subject grouped by week and timeslot
            subject_items_by_week: Dict[str, List[Tuple[int, ScheduledItem]]] = defaultdict(list)
            for idx, item in enumerate(working_items):
                if item.subject_id == subject_id:
                    week = item.week_type or "base"
                    subject_items_by_week[week].append((idx, item))

            if "A" not in subject_items_by_week or "B" not in subject_items_by_week:
                continue

            a_items = subject_items_by_week["A"]
            b_items = subject_items_by_week["B"]

            # Look for timeslots that appear in only one week (consolidation opportunity)
            a_slots = {working_items[idx].timeslot_id for idx, _ in a_items}
            b_slots = {working_items[idx].timeslot_id for idx, _ in b_items}

            # Find B slots that don't have an A counterpart
            b_only_slots = b_slots - a_slots
            if not b_only_slots:
                continue

            # Try to consolidate: move one of the existing A occurrences to match a B slot,
            # or move a B occurrence to match an A slot and swap what's blocking
            for b_slot_id in sorted(b_only_slots):
                if consolidation_improved:
                    break

                # Find any B item in this slot to use as a reference
                b_ref_idx = None
                b_ref_item = None
                for idx, item in b_items:
                    if item.timeslot_id == b_slot_id:
                        b_ref_idx = idx
                        b_ref_item = item
                        break

                if b_ref_idx is None or b_ref_item is None:
                    continue

                # Try to find an A item that could swap into this B slot
                for a_idx, a_item in a_items:
                    if a_item.start_time or a_item.end_time:
                        continue
                    if _item_units(a_item, timeslot_units_map) != _item_units(b_ref_item, timeslot_units_map):
                        continue

                    # Check if we can directly place the A item in the B slot (in week A)
                    can_place_direct = _can_place_item_in_slot(
                        a_item,
                        b_slot_id,
                        "A",
                        working_items,
                        {a_idx, b_ref_idx},
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    )

                    if can_place_direct:
                        # Direct consolidation: move A item to B's slot
                        candidate = list(working_items)
                        candidate[a_idx] = _move_item_to_slot(a_item, timeslots_by_id[b_slot_id])
                        candidate_score = _score(candidate)
                        if candidate_score < best_score:
                            working_items = candidate
                            best_score = candidate_score
                            consolidation_improved = True
                            break
                    else:
                        # Try indirect consolidation: find what's blocking and swap it
                        blocking_indices = [
                            idx
                            for idx, item in enumerate(working_items)
                            if (item.week_type or "base") == "A"
                            and item.timeslot_id == b_slot_id
                            and set(item.class_ids).intersection(a_item.class_ids)
                            and item.subject_id != subject_id
                        ]

                        for block_idx in blocking_indices:
                            if consolidation_improved:
                                break

                            blocking_item = working_items[block_idx]
                            if blocking_item.start_time or blocking_item.end_time:
                                continue
                            if _item_units(blocking_item, timeslot_units_map) != _item_units(a_item, timeslot_units_map):
                                continue

                            # Try to swap: move blocking item to a's current slot, move a to b's slot
                            can_place_blocking = _can_place_item_in_slot(
                                blocking_item,
                                a_item.timeslot_id,
                                "A",
                                working_items,
                                {a_idx, block_idx},
                                allowed_slots_by_subject,
                                allowed_weeks_by_subject,
                                teacher_unavailable,
                                blocked_class_slots_by_week,
                            )

                            if can_place_blocking:
                                candidate = list(working_items)
                                candidate[a_idx] = _move_item_to_slot(a_item, timeslots_by_id[b_slot_id])
                                candidate[block_idx] = _move_item_to_slot(blocking_item, timeslots_by_id[a_item.timeslot_id])
                                candidate_score = _score(candidate)
                                if candidate_score < best_score:
                                    working_items = candidate
                                    best_score = candidate_score
                                    consolidation_improved = True
                                    break

            if consolidation_improved:
                continue

            # Mirror pass: also handle A-only slots by moving/swapping B items.
            a_only_slots = a_slots - b_slots
            for a_slot_id in sorted(a_only_slots):
                if consolidation_improved:
                    break

                # Find any A item in this slot to use as a reference
                a_ref_idx = None
                a_ref_item = None
                for idx, item in a_items:
                    if item.timeslot_id == a_slot_id:
                        a_ref_idx = idx
                        a_ref_item = item
                        break

                if a_ref_idx is None or a_ref_item is None:
                    continue

                # Try to find a B item that could swap into this A slot
                for b_idx, b_item in b_items:
                    if b_item.start_time or b_item.end_time:
                        continue
                    if _item_units(b_item, timeslot_units_map) != _item_units(a_ref_item, timeslot_units_map):
                        continue

                    # Check if we can directly place the B item in the A slot (in week B)
                    can_place_direct = _can_place_item_in_slot(
                        b_item,
                        a_slot_id,
                        "B",
                        working_items,
                        {a_ref_idx, b_idx},
                        allowed_slots_by_subject,
                        allowed_weeks_by_subject,
                        teacher_unavailable,
                        blocked_class_slots_by_week,
                    )

                    if can_place_direct:
                        # Direct consolidation: move B item to A's slot
                        candidate = list(working_items)
                        candidate[b_idx] = _move_item_to_slot(b_item, timeslots_by_id[a_slot_id])
                        candidate_score = _score(candidate)
                        if candidate_score < best_score:
                            working_items = candidate
                            best_score = candidate_score
                            consolidation_improved = True
                            break
                    else:
                        # Try indirect consolidation: find what's blocking and swap it
                        blocking_indices = [
                            idx
                            for idx, item in enumerate(working_items)
                            if (item.week_type or "base") == "B"
                            and item.timeslot_id == a_slot_id
                            and set(item.class_ids).intersection(b_item.class_ids)
                            and item.subject_id != subject_id
                        ]

                        for block_idx in blocking_indices:
                            if consolidation_improved:
                                break

                            blocking_item = working_items[block_idx]
                            if blocking_item.start_time or blocking_item.end_time:
                                continue
                            if _item_units(blocking_item, timeslot_units_map) != _item_units(b_item, timeslot_units_map):
                                continue

                            # Try to swap: move blocking item to b's current slot, move b to a's slot
                            can_place_blocking = _can_place_item_in_slot(
                                blocking_item,
                                b_item.timeslot_id,
                                "B",
                                working_items,
                                {b_idx, block_idx},
                                allowed_slots_by_subject,
                                allowed_weeks_by_subject,
                                teacher_unavailable,
                                blocked_class_slots_by_week,
                            )

                            if can_place_blocking:
                                candidate = list(working_items)
                                candidate[b_idx] = _move_item_to_slot(b_item, timeslots_by_id[a_slot_id])
                                candidate[block_idx] = _move_item_to_slot(blocking_item, timeslots_by_id[b_item.timeslot_id])
                                candidate_score = _score(candidate)
                                if candidate_score < best_score:
                                    working_items = candidate
                                    best_score = candidate_score
                                    consolidation_improved = True
                                    break

        if not consolidation_improved:
            break

    return working_items


def _mirror_reduced_tail_for_partial_weeks(
    data: ScheduleRequest,
    schedule_items: List[ScheduledItem],
    timeslot_units_map: Dict[str, int],
) -> List[ScheduledItem]:
    """
    In partial alternating schedules, mirror reduced-tail 45m placements to the
    opposite week when feasible and when that subject is below nominal weekly load.
    """
    if not data.alternating_weeks_enabled or not schedule_items:
        return schedule_items

    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    all_timeslot_ids: Set[str] = set(timeslots_by_id.keys())
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}
    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
        block_to_timeslots[block.id] = slot_set

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for se in block.subject_entries:
            linked_block_ids[se.subject_id].add(block.id)
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)

    allowed_slots_by_subject: Dict[str, Set[str]] = {}
    allowed_weeks_by_subject: Dict[str, Set[str]] = {}
    for subject in data.subjects:
        allowed_slots_by_subject[subject.id] = _compute_allowed_timeslots(
            subject,
            all_timeslot_ids,
            block_to_timeslots,
            timeslots_by_id,
        )
        allowed_weeks_by_subject[subject.id] = _compute_allowed_weeks(
            subject,
            True,
            blocks_by_id,
            linked_block_ids,
        )

    teacher_unavailable: Dict[str, Set[str]] = defaultdict(set)
    teachers_by_id = {t.id: t for t in data.teachers}
    for teacher in data.teachers:
        teacher_unavailable[teacher.id] |= set(teacher.unavailable_timeslots)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.mode == "unavailable" and assignment.teacher_id in teachers_by_id:
                teacher_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    class_occupied_by_week_slot: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    teacher_occupied_by_week_slot: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    units_by_subject_week: Dict[Tuple[str, str], int] = defaultdict(int)
    for item in schedule_items:
        week = item.week_type or "base"
        if week not in {"A", "B"}:
            continue
        for class_id in item.class_ids:
            class_occupied_by_week_slot[(week, item.timeslot_id)].add(class_id)
        for teacher_id in _scheduled_item_teacher_ids(item):
            teacher_occupied_by_week_slot[(week, item.timeslot_id)].add(teacher_id)
        units_by_subject_week[(item.subject_id, week)] += _item_units(item, timeslot_units_map)

    reduced_tail_by_sig_week: Dict[Tuple[str, str, str, str, str], Set[str]] = defaultdict(set)
    for item in schedule_items:
        week = item.week_type or "base"
        if week not in {"A", "B"}:
            continue
        if not (item.start_time and item.end_time):
            continue
        if _item_units(item, timeslot_units_map) != 1:
            continue
        sig = (item.subject_id, item.timeslot_id, item.day, item.start_time, item.end_time)
        reduced_tail_by_sig_week[sig].add(week)

    additions: List[ScheduledItem] = []
    for sig, weeks in reduced_tail_by_sig_week.items():
        if len(weeks) != 1:
            continue
        subject_id, timeslot_id, day, start_time, end_time = sig
        subject = subjects_by_id.get(subject_id)
        if not subject:
            continue

        source_week = next(iter(weeks))
        target_week = "B" if source_week == "A" else "A"
        if target_week not in allowed_weeks_by_subject.get(subject_id, {"A", "B"}):
            continue
        if timeslot_id not in allowed_slots_by_subject.get(subject_id, set()):
            continue

        nominal_units = max(0, int(subject.sessions_per_week or 0))
        if units_by_subject_week.get((subject_id, target_week), 0) >= nominal_units:
            continue

        target_class_ids = list(subject.class_ids or [])
        if any(class_id in class_occupied_by_week_slot[(target_week, timeslot_id)] for class_id in target_class_ids):
            continue

        target_teacher_ids = _subject_teacher_ids(subject)
        if any(timeslot_id in teacher_unavailable.get(teacher_id, set()) for teacher_id in target_teacher_ids):
            continue
        if any(teacher_id in teacher_occupied_by_week_slot[(target_week, timeslot_id)] for teacher_id in target_teacher_ids):
            continue

        ts = timeslots_by_id.get(timeslot_id)
        if not ts:
            continue

        primary_teacher_id = target_teacher_ids[0] if target_teacher_ids else ""
        additions.append(
            ScheduledItem(
                subject_id=subject_id,
                subject_name=subject.name,
                teacher_id=primary_teacher_id,
                teacher_ids=target_teacher_ids,
                class_ids=target_class_ids,
                timeslot_id=timeslot_id,
                day=day,
                period=ts.period,
                start_time=start_time,
                end_time=end_time,
                week_type=target_week,
            )
        )

        for class_id in target_class_ids:
            class_occupied_by_week_slot[(target_week, timeslot_id)].add(class_id)
        for teacher_id in target_teacher_ids:
            teacher_occupied_by_week_slot[(target_week, timeslot_id)].add(teacher_id)
        units_by_subject_week[(subject_id, target_week)] += 1

    if not additions:
        return schedule_items
    return schedule_items + additions


def _fill_reduced_tail_shortage_for_partial_weeks(
    data: ScheduleRequest,
    schedule_items: List[ScheduledItem],
    timeslot_units_map: Dict[str, int],
) -> List[ScheduledItem]:
    """
    In partial alternating schedules, try to add missing odd 45-minute units
    (e.g. 3x45 subjects currently at 2x45) using reduced-tail block spill slots.
    """
    if not data.alternating_weeks_enabled or not schedule_items:
        return schedule_items

    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    all_timeslot_ids: Set[str] = set(timeslots_by_id.keys())
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}
    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
        block_to_timeslots[block.id] = slot_set

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for se in block.subject_entries:
            linked_block_ids[se.subject_id].add(block.id)
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)

    allowed_slots_by_subject: Dict[str, Set[str]] = {}
    allowed_weeks_by_subject: Dict[str, Set[str]] = {}
    for subject in data.subjects:
        allowed_slots_by_subject[subject.id] = _compute_allowed_timeslots(
            subject,
            all_timeslot_ids,
            block_to_timeslots,
            timeslots_by_id,
        )
        allowed_weeks_by_subject[subject.id] = _compute_allowed_weeks(
            subject,
            True,
            blocks_by_id,
            linked_block_ids,
        )

    teacher_unavailable: Dict[str, Set[str]] = defaultdict(set)
    teachers_by_id = {t.id: t for t in data.teachers}
    for teacher in data.teachers:
        teacher_unavailable[teacher.id] |= set(teacher.unavailable_timeslots)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.mode == "unavailable" and assignment.teacher_id in teachers_by_id:
                teacher_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    class_occupied_by_week_slot: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    teacher_occupied_by_week_slot: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    units_by_subject_week: Dict[Tuple[str, str], int] = defaultdict(int)
    existing_reduced_tail_sigs: Set[Tuple[str, str, str, str, str]] = set()

    for item in schedule_items:
        week = item.week_type or "base"
        if week not in {"A", "B"}:
            continue
        for class_id in item.class_ids:
            class_occupied_by_week_slot[(week, item.timeslot_id)].add(class_id)
        for teacher_id in _scheduled_item_teacher_ids(item):
            teacher_occupied_by_week_slot[(week, item.timeslot_id)].add(teacher_id)
        units_by_subject_week[(item.subject_id, week)] += _item_units(item, timeslot_units_map)

        if item.start_time and item.end_time and _item_units(item, timeslot_units_map) == 1:
            existing_reduced_tail_sigs.add(
                (item.subject_id, week, item.timeslot_id, item.start_time, item.end_time)
            )

    reduced_tail_span_by_week_class_slot: Dict[Tuple[str, str, str], Tuple[str, str]] = {}
    for block in data.blocks:
        if not block.class_ids:
            continue
        for occ in block.occurrences:
            occ_week = (occ.week_type or "both").upper()
            target_weeks = ["A", "B"] if occ_week == "BOTH" else [occ_week]
            matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids

            occ_start = _to_minutes(occ.start_time)
            occ_end = _to_minutes(occ.end_time)
            if occ_start is None or occ_end is None:
                continue

            for ts_id in matched_slots:
                ts = timeslots_by_id.get(ts_id)
                if not ts:
                    continue
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
                for week in target_weeks:
                    if week not in {"A", "B"}:
                        continue
                    for class_id in block.class_ids:
                        reduced_tail_span_by_week_class_slot[(week, class_id, ts_id)] = reduced_span

    def _slot_sort_key(ts_id: str) -> Tuple[int, int]:
        ts = timeslots_by_id[ts_id]
        day_index = DAY_ORDER_INDEX.get((ts.day or "").lower(), 99)
        return (day_index, ts.period)

    additions: List[ScheduledItem] = []
    candidate_subjects = sorted(
        data.subjects,
        key=lambda s: (
            -(
                max(0, 2 * int(s.sessions_per_week or 0) - (
                    units_by_subject_week.get((s.id, "A"), 0)
                    + units_by_subject_week.get((s.id, "B"), 0)
                ))
            ),
            s.id,
        ),
    )

    for subject in candidate_subjects:
        nominal_units = max(0, int(subject.sessions_per_week or 0))
        if nominal_units <= 0 or (nominal_units % 2) == 0:
            continue

        target_two_week_units = 2 * nominal_units
        current_two_week_units = (
            units_by_subject_week.get((subject.id, "A"), 0)
            + units_by_subject_week.get((subject.id, "B"), 0)
        )
        # Only fill subjects with an actual two-week shortage.
        if current_two_week_units >= target_two_week_units:
            continue

        subject_id = subject.id
        class_ids = list(subject.class_ids or [])
        if not class_ids:
            continue
        teacher_ids = _subject_teacher_ids(subject)
        primary_teacher_id = teacher_ids[0] if teacher_ids else ""

        for week in ("A", "B"):
            if week not in allowed_weeks_by_subject.get(subject_id, {"A", "B"}):
                continue

            current_two_week_units = (
                units_by_subject_week.get((subject_id, "A"), 0)
                + units_by_subject_week.get((subject_id, "B"), 0)
            )
            if current_two_week_units >= target_two_week_units:
                break

            missing_units = nominal_units - units_by_subject_week.get((subject_id, week), 0)
            if missing_units <= 0:
                continue

            candidate_slots = sorted(
                list(allowed_slots_by_subject.get(subject_id, set())),
                key=_slot_sort_key,
            )

            for ts_id in candidate_slots:
                if missing_units <= 0:
                    break

                reduced_spans = {
                    reduced_tail_span_by_week_class_slot[(week, class_id, ts_id)]
                    for class_id in class_ids
                    if (week, class_id, ts_id) in reduced_tail_span_by_week_class_slot
                }
                if len(reduced_spans) != 1:
                    continue

                start_time, end_time = next(iter(reduced_spans))
                sig = (subject_id, week, ts_id, start_time, end_time)
                if sig in existing_reduced_tail_sigs:
                    continue

                if any(class_id in class_occupied_by_week_slot[(week, ts_id)] for class_id in class_ids):
                    continue
                if any(ts_id in teacher_unavailable.get(teacher_id, set()) for teacher_id in teacher_ids):
                    continue
                if any(teacher_id in teacher_occupied_by_week_slot[(week, ts_id)] for teacher_id in teacher_ids):
                    continue

                ts = timeslots_by_id.get(ts_id)
                if not ts:
                    continue

                item = ScheduledItem(
                    subject_id=subject_id,
                    subject_name=subject.name,
                    teacher_id=primary_teacher_id,
                    teacher_ids=teacher_ids,
                    class_ids=class_ids,
                    timeslot_id=ts_id,
                    day=ts.day,
                    period=ts.period,
                    start_time=start_time,
                    end_time=end_time,
                    week_type=week,
                )
                additions.append(item)

                for class_id in class_ids:
                    class_occupied_by_week_slot[(week, ts_id)].add(class_id)
                for teacher_id in teacher_ids:
                    teacher_occupied_by_week_slot[(week, ts_id)].add(teacher_id)
                units_by_subject_week[(subject_id, week)] += 1
                existing_reduced_tail_sigs.add(sig)
                missing_units -= 1

    if not additions:
        return schedule_items
    return schedule_items + additions


def _rebalance_1tmt_naturfag_samf_partial(
    data: ScheduleRequest,
    schedule_items: List[ScheduledItem],
) -> List[ScheduledItem]:
    """
    Targeted partial-week rebalance for 1TMT:
    - Move Naturfag from Thu-2 (B) to Fri-4 (B) when possible.
    - Place Samfunnskunnskap at Thu-2 (B).
    - If Samf teacher is blocked at Thu-2 by Norsk vg3 (3STE), try moving
      that blocker to a feasible Monday/Friday slot first.
    """
    if not data.alternating_weeks_enabled or not schedule_items:
        return schedule_items

    week = "B"
    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    if "Thu-2" not in timeslots_by_id or "Fri-4" not in timeslots_by_id:
        return schedule_items

    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}
    all_timeslot_ids: Set[str] = set(timeslots_by_id.keys())
    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, data.timeslots) & all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
        block_to_timeslots[block.id] = slot_set

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for se in block.subject_entries:
            linked_block_ids[se.subject_id].add(block.id)
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)

    naturfag_subject = next(
        (
            s
            for s in data.subjects
            if "class_1tmt" in (s.class_ids or []) and "naturfag" in (s.name or "").lower()
        ),
        None,
    )
    samf_subject = next(
        (
            s
            for s in data.subjects
            if "class_1tmt" in (s.class_ids or []) and "samfunnskunnskap" in (s.name or "").lower()
        ),
        None,
    )
    if not naturfag_subject or not samf_subject:
        return schedule_items

    naturfag_teacher_ids = _subject_teacher_ids(naturfag_subject)
    samf_teacher_ids = _subject_teacher_ids(samf_subject)
    if not samf_teacher_ids:
        return schedule_items

    allowed_slots_naturfag = _compute_allowed_timeslots(
        naturfag_subject,
        all_timeslot_ids,
        block_to_timeslots,
        timeslots_by_id,
    )
    allowed_slots_samf = _compute_allowed_timeslots(
        samf_subject,
        all_timeslot_ids,
        block_to_timeslots,
        timeslots_by_id,
    )
    allowed_weeks_naturfag = _compute_allowed_weeks(
        naturfag_subject,
        True,
        blocks_by_id,
        linked_block_ids,
    )
    allowed_weeks_samf = _compute_allowed_weeks(
        samf_subject,
        True,
        blocks_by_id,
        linked_block_ids,
    )
    if week not in allowed_weeks_naturfag or week not in allowed_weeks_samf:
        return schedule_items
    if "Fri-4" not in allowed_slots_naturfag or "Thu-2" not in allowed_slots_samf:
        return schedule_items

    teacher_unavailable: Dict[str, Set[str]] = defaultdict(set)
    teachers_by_id = {t.id: t for t in data.teachers}
    for teacher in data.teachers:
        teacher_unavailable[teacher.id] |= set(teacher.unavailable_timeslots)
    for meeting in data.meetings:
        if meeting.timeslot_id not in all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.mode == "unavailable" and assignment.teacher_id in teachers_by_id:
                teacher_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    working_items = list(schedule_items)

    def _slot_conflict_for_subject(
        items: List[ScheduledItem],
        subject: Subject,
        slot_id: str,
        planning_week: str,
        subject_teacher_ids: List[str],
        ignore_idx: int | None = None,
    ) -> bool:
        if any(slot_id in teacher_unavailable.get(tid, set()) for tid in subject_teacher_ids):
            return True

        subject_classes = set(subject.class_ids or [])
        for idx, existing in enumerate(items):
            if ignore_idx is not None and idx == ignore_idx:
                continue
            if (existing.week_type or "base") != planning_week:
                continue
            if existing.timeslot_id != slot_id:
                continue

            existing_classes = set(existing.class_ids or [])
            if subject_classes & existing_classes:
                return True

            existing_teachers = set(_scheduled_item_teacher_ids(existing))
            if any(tid in existing_teachers for tid in subject_teacher_ids):
                return True
        return False

    naturfag_idx = next(
        (
            idx
            for idx, item in enumerate(working_items)
            if item.subject_id == naturfag_subject.id
            and (item.week_type or "base") == week
            and item.timeslot_id == "Thu-2"
            and not (item.start_time or item.end_time)
        ),
        None,
    )
    if naturfag_idx is None:
        return schedule_items

    # If Samf teacher is blocked at Thu-2, try to relocate one blocker first.
    blockers = [
        idx
        for idx, item in enumerate(working_items)
        if (item.week_type or "base") == week
        and item.timeslot_id == "Thu-2"
        and any(tid in set(_scheduled_item_teacher_ids(item)) for tid in samf_teacher_ids)
        and item.subject_id != samf_subject.id
    ]

    if blockers:
        blocker_idx = blockers[0]
        blocker_item = working_items[blocker_idx]
        blocker_subject = subjects_by_id.get(blocker_item.subject_id)
        if not blocker_subject or (blocker_item.start_time or blocker_item.end_time):
            return schedule_items

        blocker_teacher_ids = _subject_teacher_ids(blocker_subject)
        blocker_allowed_slots = _compute_allowed_timeslots(
            blocker_subject,
            all_timeslot_ids,
            block_to_timeslots,
            timeslots_by_id,
        )

        preferred_order = ["Mon-1", "Mon-4", "Fri-1", "Fri-4", "Tue-1", "Wed-1"]
        remaining_slots = sorted(
            [slot_id for slot_id in blocker_allowed_slots if slot_id not in set(preferred_order)],
            key=lambda slot_id: (
                DAY_ORDER_INDEX.get((timeslots_by_id[slot_id].day or "").lower(), 99),
                timeslots_by_id[slot_id].period,
            ),
        )
        candidate_slots = [slot_id for slot_id in preferred_order if slot_id in blocker_allowed_slots] + remaining_slots

        moved_blocker = False
        for candidate_slot in candidate_slots:
            if candidate_slot == blocker_item.timeslot_id:
                continue
            if _slot_conflict_for_subject(
                working_items,
                blocker_subject,
                candidate_slot,
                week,
                blocker_teacher_ids,
                ignore_idx=blocker_idx,
            ):
                continue

            ts = timeslots_by_id[candidate_slot]
            blocker_item.timeslot_id = candidate_slot
            blocker_item.day = ts.day
            blocker_item.period = ts.period
            blocker_item.start_time = None
            blocker_item.end_time = None
            moved_blocker = True
            break

        if not moved_blocker:
            return schedule_items

    # Move Naturfag Thu-2(B) -> Fri-4(B).
    if _slot_conflict_for_subject(
        working_items,
        naturfag_subject,
        "Fri-4",
        week,
        naturfag_teacher_ids,
        ignore_idx=naturfag_idx,
    ):
        return schedule_items

    naturfag_item = working_items[naturfag_idx]
    naturfag_item.timeslot_id = "Fri-4"
    naturfag_item.day = timeslots_by_id["Fri-4"].day
    naturfag_item.period = timeslots_by_id["Fri-4"].period
    naturfag_item.start_time = None
    naturfag_item.end_time = None

    # Place Samfunnskunnskap at Thu-2(B) as a full 90-minute slot.
    if any(
        (item.week_type or "base") == week
        and item.subject_id == samf_subject.id
        and item.timeslot_id == "Thu-2"
        for item in working_items
    ):
        return working_items

    if _slot_conflict_for_subject(
        working_items,
        samf_subject,
        "Thu-2",
        week,
        samf_teacher_ids,
    ):
        return schedule_items

    working_items.append(
        ScheduledItem(
            subject_id=samf_subject.id,
            subject_name=samf_subject.name,
            teacher_id=samf_teacher_ids[0],
            teacher_ids=samf_teacher_ids,
            class_ids=list(samf_subject.class_ids or []),
            timeslot_id="Thu-2",
            day=timeslots_by_id["Thu-2"].day,
            period=timeslots_by_id["Thu-2"].period,
            week_type=week,
        )
    )

    return working_items


def generate_schedule(data: ScheduleRequest) -> ScheduleResponse:
    _solver_log(f"[RUN] generate_schedule called with alternating_weeks_enabled={data.alternating_weeks_enabled}", reset=True)
    if not data.alternating_weeks_enabled:
        odd_ids = [s.id for s in data.subjects if int(s.sessions_per_week or 1) % 2 == 1]
        odd_ids_sorted = sorted(odd_ids)

        attempts = [
            _generate_schedule_staged(
                data,
                partial_subject_priority="first",
                subject_priority_rank={sid: i for i, sid in enumerate(odd_ids_sorted)},
            ),
            _generate_schedule_staged(
                data,
                partial_subject_priority="last",
                subject_priority_rank={sid: i for i, sid in enumerate(reversed(odd_ids_sorted))},
            ),
        ]
        for attempt in attempts:
            if attempt.status == "success":
                return attempt
        return attempts[0]

    # Collect subjects linked to blocks — their placements are driven by block
    # occurrence windows, not by sessions_per_week, so they are excluded from
    # the A/B unit-balancing logic below.
    block_subject_ids: Set[str] = set()
    for block in data.blocks:
        for entry in block.subject_entries:
            block_subject_ids.add(entry.subject_id)
        for sid in block.subject_ids:
            block_subject_ids.add(sid)

    timeslot_units_map: Dict[str, int] = {t.id: _timeslot_45m_units(t) for t in data.timeslots}
    subjects_by_id: Dict[str, Subject] = {s.id: s for s in data.subjects}
    class_to_base_room: Dict[str, str] = {
        cls.id: cls.base_room_id
        for cls in data.classes
        if cls.base_room_id
    }

    # A/B splits are DISABLED - use auto-balancing instead
    explicit_a_overrides: Dict[str, int] = {}
    explicit_b_overrides: Dict[str, int] = {}

    auto_balanced_odd_subject_ids: Set[str] = {
        subj.id
        for subj in data.subjects
        if subj.id not in block_subject_ids
        and (int(subj.sessions_per_week or 1) % 2) == 1
        and subj.id not in explicit_a_overrides
    }

    nominal_target_units_by_class: Dict[str, int] = defaultdict(int)
    for subject in data.subjects:
        weekly_units = max(0, int(subject.sessions_per_week or 0))
        if weekly_units <= 0:
            continue
        for class_id in subject.class_ids:
            nominal_target_units_by_class[class_id] += weekly_units

    alternating_timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    alternating_all_timeslot_ids: Set[str] = set(alternating_timeslots_by_id.keys())
    alternating_timeslot_units_by_id: Dict[str, int] = {
        t.id: _timeslot_45m_units(t) for t in data.timeslots
    }
    alternating_teachers_by_id = {t.id: t for t in data.teachers}
    alternating_teacher_meeting_unavailable: Dict[str, Set[str]] = defaultdict(set)
    for meeting in data.meetings:
        if meeting.timeslot_id not in alternating_all_timeslot_ids:
            continue
        for assignment in meeting.teacher_assignments:
            if assignment.mode == "unavailable":
                alternating_teacher_meeting_unavailable[assignment.teacher_id].add(meeting.timeslot_id)

    alternating_block_to_timeslots: Dict[str, Set[str]] = {}
    for block in data.blocks:
        slot_set: Set[str] = set()
        has_occurrences = bool(block.occurrences)
        for occ in block.occurrences:
            slot_set |= (_timeslots_overlapping_occurrence(occ, data.timeslots) & alternating_all_timeslot_ids)
        if not has_occurrences:
            slot_set |= (set(block.timeslot_ids) & alternating_all_timeslot_ids)
        alternating_block_to_timeslots[block.id] = slot_set

    alternating_subject_teacher_ids: Dict[str, List[str]] = {
        s.id: _subject_teacher_ids(s) for s in data.subjects
    }
    week_labels_for_rules: Set[str] = {"A", "B"} if data.alternating_weeks_enabled else {"base"}

    block_slots_by_subject_for_rules: Dict[str, Set[str]] = defaultdict(set)
    linked_block_ids_for_rules: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        block_slot_ids = alternating_block_to_timeslots.get(block.id, set())
        block_subject_set = {entry.subject_id for entry in block.subject_entries} | set(block.subject_ids)
        for subject_id in block_subject_set:
            if subject_id:
                block_slots_by_subject_for_rules[subject_id].update(block_slot_ids)
                linked_block_ids_for_rules[subject_id].add(block.id)

    blocks_by_id_for_rules: Dict[str, Block] = {b.id: b for b in data.blocks}
    blocked_class_slots_by_week_for_rules: Dict[Tuple[str, str], Set[str]] = defaultdict(set)
    for block in data.blocks:
        has_occurrences = bool(block.occurrences)
        if has_occurrences:
            for occ in block.occurrences:
                matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots) & alternating_all_timeslot_ids
                occ_week = (occ.week_type or "both").upper()
                if data.alternating_weeks_enabled:
                    if occ_week == "A":
                        target_weeks = {"A"}
                    elif occ_week == "B":
                        target_weeks = {"B"}
                    else:
                        target_weeks = {"A", "B"}
                else:
                    target_weeks = {"base"}
                for class_id in block.class_ids:
                    for week_key in target_weeks:
                        blocked_class_slots_by_week_for_rules[(class_id, week_key)].update(matched_slots)
        else:
            legacy_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
            slot_ids = set(block.timeslot_ids) & alternating_all_timeslot_ids
            for class_id in block.class_ids:
                for week_key in legacy_weeks:
                    blocked_class_slots_by_week_for_rules[(class_id, week_key)].update(slot_ids)

    def _item_teacher_ids_for_rules(item: ScheduledItem) -> List[str]:
        teacher_ids: List[str] = []
        if item.teacher_id:
            teacher_ids.append(item.teacher_id)
        teacher_ids.extend(item.teacher_ids or [])
        return list(dict.fromkeys([teacher_id for teacher_id in teacher_ids if teacher_id]))

    def _is_block_item_for_rules(item: ScheduledItem) -> bool:
        return item.timeslot_id in block_slots_by_subject_for_rules.get(item.subject_id, set())

    def _hard_post_rule_violation_counts(schedule_items: List[ScheduledItem]) -> Tuple[int, int]:
        # Validation-only: never drop sessions here. x45 totals must remain intact.
        subject_day_violations = 0
        grouped_by_subject_day: Dict[Tuple[str, str, str], int] = defaultdict(int)
        for item in schedule_items:
            grouped_by_subject_day[(item.subject_id, item.week_type or "base", item.day)] += 1
        for (subject_id, _week_key, _day), count in grouped_by_subject_day.items():
            subject = subjects_by_id.get(subject_id)
            if _is_norsk_vg3_subject(subject):
                continue
            if count > 1:
                subject_day_violations += count - 1

        teacher_day_violations = 0
        teacher_day_counts: Dict[Tuple[str, str, str], int] = defaultdict(int)
        for item in schedule_items:
            week_key = item.week_type or "base"
            for teacher_id in _item_teacher_ids_for_rules(item):
                teacher_day_counts[(teacher_id, week_key, item.day)] += 1
        for _key, count in teacher_day_counts.items():
            if count > 3:
                teacher_day_violations += count - 3

        return subject_day_violations, teacher_day_violations

    def _repair_missing_units(schedule_items: List[ScheduledItem]) -> Tuple[List[ScheduledItem], int]:
        working_items = list(schedule_items)

        placed_units_by_subject: Dict[str, int] = defaultdict(int)
        class_busy: Set[Tuple[str, str, str]] = set()
        teacher_busy: Set[Tuple[str, str, str]] = set()
        teacher_day_count: Dict[Tuple[str, str, str], int] = defaultdict(int)
        subject_day_used: Dict[Tuple[str, str, str], int] = defaultdict(int)

        for item in working_items:
            week_key = item.week_type or "base"
            item_units = _item_units(item, timeslot_units_map)
            if item.subject_id not in block_subject_ids:
                placed_units_by_subject[item.subject_id] += item_units
            subject_day_used[(item.subject_id, week_key, item.day)] += 1
            for class_id in item.class_ids:
                class_busy.add((class_id, week_key, item.timeslot_id))
            for teacher_id in _item_teacher_ids_for_rules(item):
                teacher_busy.add((teacher_id, week_key, item.timeslot_id))
                teacher_day_count[(teacher_id, week_key, item.day)] += 1

        def _rebuild_usage_maps() -> None:
            class_busy.clear()
            teacher_busy.clear()
            teacher_day_count.clear()
            subject_day_used.clear()

            for scheduled_item in working_items:
                week_key = scheduled_item.week_type or "base"
                subject_day_used[(scheduled_item.subject_id, week_key, scheduled_item.day)] += 1
                for class_id in scheduled_item.class_ids:
                    class_busy.add((class_id, week_key, scheduled_item.timeslot_id))
                for teacher_id in _item_teacher_ids_for_rules(scheduled_item):
                    teacher_busy.add((teacher_id, week_key, scheduled_item.timeslot_id))
                    teacher_day_count[(teacher_id, week_key, scheduled_item.day)] += 1

        added_count = 0

        def _find_class_conflicting_items(
            class_ids: List[str],
            week_key: str,
            timeslot_id: str,
            exclude_subject_id: str,
        ) -> List[ScheduledItem]:
            conflicts: List[ScheduledItem] = []
            for item in working_items:
                item_week = item.week_type or "base"
                if item_week != week_key:
                    continue
                if item.timeslot_id != timeslot_id:
                    continue
                if item.subject_id == exclude_subject_id:
                    continue
                if any(class_id in (item.class_ids or []) for class_id in class_ids):
                    conflicts.append(item)
            return conflicts

        def _try_relocate_item(
            item: ScheduledItem,
            target_week_key: str,
            blocked_timeslot_id: str,
            depth_remaining: int = 1,
            seen_item_ids: Set[int] | None = None,
        ) -> bool:
            if seen_item_ids is None:
                seen_item_ids = set()

            item_ref = id(item)
            if item_ref in seen_item_ids:
                return False

            # Never move block-bound placements here.
            if _is_block_item_for_rules(item):
                return False

            subject = subjects_by_id.get(item.subject_id)
            if not subject:
                return False

            old_slot = alternating_timeslots_by_id.get(item.timeslot_id)
            if not old_slot:
                return False
            old_day = item.day
            old_units = _item_units(item, timeslot_units_map)

            allowed_slots = _compute_allowed_timeslots(
                subject,
                alternating_all_timeslot_ids,
                alternating_block_to_timeslots,
                alternating_timeslots_by_id,
            )
            allowed_weeks = _compute_allowed_weeks(
                subject,
                data.alternating_weeks_enabled,
                blocks_by_id_for_rules,
                linked_block_ids_for_rules,
            )
            if target_week_key not in allowed_weeks:
                return False

            teacher_ids = _subject_teacher_ids(subject)
            filtered_slots = set(allowed_slots)
            for teacher_id in teacher_ids:
                if teacher_id in alternating_teachers_by_id:
                    filtered_slots -= set(alternating_teachers_by_id[teacher_id].unavailable_timeslots)
                filtered_slots -= alternating_teacher_meeting_unavailable.get(teacher_id, set())

            subject_day_counts: Dict[str, int] = defaultdict(int)
            for scheduled_item in working_items:
                scheduled_week = scheduled_item.week_type or "base"
                if scheduled_week != target_week_key:
                    continue
                if scheduled_item.subject_id != item.subject_id:
                    continue
                if scheduled_item is item:
                    continue
                subject_day_counts[scheduled_item.day] += 1

            for candidate_slot_id in sorted(filtered_slots, key=_alternating_slot_sort_key):
                if candidate_slot_id == item.timeslot_id or candidate_slot_id == blocked_timeslot_id:
                    continue

                candidate_slot = alternating_timeslots_by_id[candidate_slot_id]
                if timeslot_units_map.get(candidate_slot_id, 1) != old_units:
                    continue

                # same-subject/day rule for relocated item (except Norsk vg3)
                if not _is_norsk_vg3_subject(subject):
                    if subject_day_counts.get(candidate_slot.day, 0) >= 1:
                        continue

                # class checks
                class_conflict = False
                class_conflicting_items: List[ScheduledItem] = []
                for class_id in item.class_ids:
                    if candidate_slot_id in blocked_class_slots_by_week_for_rules.get((class_id, target_week_key), set()):
                        class_conflict = True
                        break
                    for other_item in working_items:
                        if other_item is item:
                            continue
                        other_week = other_item.week_type or "base"
                        if other_week != target_week_key or other_item.timeslot_id != candidate_slot_id:
                            continue
                        if class_id in (other_item.class_ids or []):
                            class_conflict = True
                            class_conflicting_items.append(other_item)
                            break
                    if class_conflict:
                        break
                if class_conflict and depth_remaining > 0 and class_conflicting_items:
                    moved_blocker = False
                    next_seen = set(seen_item_ids)
                    next_seen.add(item_ref)
                    for blocking_item in class_conflicting_items:
                        if _try_relocate_item(
                            blocking_item,
                            target_week_key,
                            candidate_slot_id,
                            depth_remaining=depth_remaining - 1,
                            seen_item_ids=next_seen,
                        ):
                            moved_blocker = True
                    if moved_blocker:
                        class_conflict = False
                        for class_id in item.class_ids:
                            for other_item in working_items:
                                if other_item is item:
                                    continue
                                other_week = other_item.week_type or "base"
                                if other_week != target_week_key or other_item.timeslot_id != candidate_slot_id:
                                    continue
                                if class_id in (other_item.class_ids or []):
                                    class_conflict = True
                                    break
                            if class_conflict:
                                break
                if class_conflict:
                    continue

                # teacher checks
                teacher_conflict = False
                for teacher_id in teacher_ids:
                    for other_item in working_items:
                        if other_item is item:
                            continue
                        other_week = other_item.week_type or "base"
                        if other_week != target_week_key or other_item.timeslot_id != candidate_slot_id:
                            continue
                        if teacher_id in _item_teacher_ids_for_rules(other_item):
                            teacher_conflict = True
                            break
                    if teacher_conflict:
                        break

                    current_day_count = teacher_day_count[(teacher_id, target_week_key, old_slot.day)]
                    new_day_count = teacher_day_count[(teacher_id, target_week_key, candidate_slot.day)]
                    adjusted_new_day_count = new_day_count + (0 if candidate_slot.day == old_slot.day else 1)
                    adjusted_current_day_count = current_day_count - (0 if candidate_slot.day == old_slot.day else 1)
                    if adjusted_new_day_count > 3 or adjusted_current_day_count < 0:
                        teacher_conflict = True
                        break
                if teacher_conflict:
                    continue

                # apply move
                for class_id in item.class_ids:
                    class_busy.discard((class_id, target_week_key, item.timeslot_id))
                    class_busy.add((class_id, target_week_key, candidate_slot_id))
                for teacher_id in teacher_ids:
                    teacher_busy.discard((teacher_id, target_week_key, item.timeslot_id))
                    teacher_busy.add((teacher_id, target_week_key, candidate_slot_id))
                    if candidate_slot.day != old_slot.day:
                        teacher_day_count[(teacher_id, target_week_key, old_slot.day)] -= 1
                        teacher_day_count[(teacher_id, target_week_key, candidate_slot.day)] += 1

                item.timeslot_id = candidate_slot_id
                item.day = candidate_slot.day
                item.period = candidate_slot.period
                item.start_time = None
                item.end_time = None

                # Keep same-day counters consistent for later checks/repairs.
                subject_day_used[(item.subject_id, target_week_key, old_day)] = max(
                    0,
                    subject_day_used[(item.subject_id, target_week_key, old_day)] - 1,
                )
                subject_day_used[(item.subject_id, target_week_key, candidate_slot.day)] += 1
                return True

            return False

        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue

            weekly_units = max(0, int(subject.sessions_per_week or 0))
            expected_total = weekly_units * (2 if data.alternating_weeks_enabled else 1)
            shortfall = expected_total - placed_units_by_subject.get(subject.id, 0)
            if shortfall <= 0:
                continue

            teacher_ids = alternating_subject_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
            primary_teacher_id = teacher_ids[0] if teacher_ids else ""

            allowed_slots = _compute_allowed_timeslots(
                subject,
                alternating_all_timeslot_ids,
                alternating_block_to_timeslots,
                alternating_timeslots_by_id,
            )
            allowed_weeks = _compute_allowed_weeks(
                subject,
                data.alternating_weeks_enabled,
                blocks_by_id_for_rules,
                linked_block_ids_for_rules,
            )

            # Respect teacher unavailability and meeting locks.
            filtered_slots = set(allowed_slots)
            for teacher_id in teacher_ids:
                if teacher_id in alternating_teachers_by_id:
                    filtered_slots -= set(alternating_teachers_by_id[teacher_id].unavailable_timeslots)
                filtered_slots -= alternating_teacher_meeting_unavailable.get(teacher_id, set())
            allowed_slots = filtered_slots

            candidate_keys: List[Tuple[str, str]] = [
                (week_key, ts_id)
                for week_key in sorted(allowed_weeks)
                for ts_id in sorted(allowed_slots, key=_alternating_slot_sort_key)
                if week_key in week_labels_for_rules
            ]

            subject_slots_by_week: Dict[str, Set[str]] = {"A": set(), "B": set(), "base": set()}
            for scheduled_item in working_items:
                if scheduled_item.subject_id != subject.id:
                    continue
                scheduled_week = scheduled_item.week_type or "base"
                subject_slots_by_week.setdefault(scheduled_week, set()).add(scheduled_item.timeslot_id)

            # Prefer Thursday last period for samfunnskunnskap where feasible.
            def _candidate_rank(week_key: str, ts_id: str) -> Tuple[int, int, int, str, str]:
                ts = alternating_timeslots_by_id[ts_id]
                is_target_samf_tail = (
                    ("samfunnskunnskap" in (subject.name or "").lower())
                    and ts.day.lower() == "thursday"
                    and ts.period == 4
                )

                # First preference: mirror a slot already used in the opposite week.
                opposite_week = "B" if week_key == "A" else ("A" if week_key == "B" else "base")
                mirrored_slot = ts_id in subject_slots_by_week.get(opposite_week, set())
                same_week_existing_slot = ts_id in subject_slots_by_week.get(week_key, set())

                return (
                    0 if mirrored_slot else 1,
                    0 if same_week_existing_slot else 1,
                    0 if is_target_samf_tail else 1,
                    DAY_ORDER_INDEX.get(ts.day.lower(), 99),
                    ts.period,
                    week_key,
                    ts_id,
                )

            candidate_keys.sort(key=lambda k: _candidate_rank(k[0], k[1]))

            progress = True
            while shortfall > 0 and progress:
                progress = False
                for week_key, ts_id in candidate_keys:
                    ts = alternating_timeslots_by_id[ts_id]
                    slot_units = timeslot_units_map.get(ts_id, 1)
                    if slot_units > shortfall:
                        continue

                    # Class conflict checks, including block lock windows.
                    class_conflict = False
                    for class_id in subject.class_ids:
                        if (class_id, week_key, ts_id) in class_busy:
                            class_conflict = True
                            break
                        if ts_id in blocked_class_slots_by_week_for_rules.get((class_id, week_key), set()):
                            class_conflict = True
                            break
                    if class_conflict:
                        conflicting_items = _find_class_conflicting_items(
                            list(subject.class_ids),
                            week_key,
                            ts_id,
                            subject.id,
                        )
                        moved_any = False
                        for conflicting_item in conflicting_items:
                            if _try_relocate_item(conflicting_item, week_key, ts_id):
                                moved_any = True
                        if moved_any:
                            class_conflict = False
                            for class_id in subject.class_ids:
                                if (class_id, week_key, ts_id) in class_busy:
                                    class_conflict = True
                                    break
                        if class_conflict:
                            continue

                    # Teacher conflict and daily cap.
                    teacher_conflict = False
                    for teacher_id in teacher_ids:
                        if (teacher_id, week_key, ts_id) in teacher_busy:
                            teacher_conflict = True
                            break
                        if teacher_day_count[(teacher_id, week_key, ts.day)] >= 3:
                            teacher_conflict = True
                            break
                    if teacher_conflict:
                        continue

                    # Same-subject/day rule (except Norsk vg3).
                    if not _is_norsk_vg3_subject(subject):
                        if subject_day_used[(subject.id, week_key, ts.day)] >= 1:
                            continue

                    new_item = ScheduledItem(
                        subject_id=subject.id,
                        subject_name=subject.name,
                        teacher_id=primary_teacher_id,
                        teacher_ids=teacher_ids,
                        class_ids=list(subject.class_ids),
                        timeslot_id=ts_id,
                        day=ts.day,
                        period=ts.period,
                        week_type=(None if week_key == "base" else week_key),
                    )
                    working_items.append(new_item)
                    added_count += 1
                    shortfall -= slot_units
                    placed_units_by_subject[subject.id] += slot_units
                    subject_day_used[(subject.id, week_key, ts.day)] += 1
                    for class_id in subject.class_ids:
                        class_busy.add((class_id, week_key, ts_id))
                    for teacher_id in teacher_ids:
                        teacher_busy.add((teacher_id, week_key, ts_id))
                        teacher_day_count[(teacher_id, week_key, ts.day)] += 1

                    progress = True
                    break

        # Second-stage local search: fix remaining hard-rule violations via relocations
        # without changing totals.
        def _subject_day_violation_items() -> List[ScheduledItem]:
            grouped: Dict[Tuple[str, str, str], List[ScheduledItem]] = defaultdict(list)
            for scheduled_item in working_items:
                grouped[(scheduled_item.subject_id, scheduled_item.week_type or "base", scheduled_item.day)].append(scheduled_item)

            candidates: List[ScheduledItem] = []
            for (subject_id, _week_key, _day), grouped_items in grouped.items():
                subject = subjects_by_id.get(subject_id)
                if _is_norsk_vg3_subject(subject):
                    continue
                if len(grouped_items) <= 1:
                    continue
                for idx, grouped_item in enumerate(grouped_items):
                    if idx == 0:
                        continue
                    candidates.append(grouped_item)
            return candidates

        def _teacher_day_violation_items() -> List[ScheduledItem]:
            grouped: Dict[Tuple[str, str, str], List[ScheduledItem]] = defaultdict(list)
            for scheduled_item in working_items:
                week_key = scheduled_item.week_type or "base"
                for teacher_id in _item_teacher_ids_for_rules(scheduled_item):
                    grouped[(teacher_id, week_key, scheduled_item.day)].append(scheduled_item)

            candidates: List[ScheduledItem] = []
            for (_teacher_id, _week_key, _day), grouped_items in grouped.items():
                if len(grouped_items) <= 3:
                    continue
                for grouped_item in grouped_items:
                    candidates.append(grouped_item)

            # Try moving non-block items first.
            candidates.sort(key=lambda it: 1 if _is_block_item_for_rules(it) else 0)
            return candidates

        max_violation_moves = 120
        for _ in range(max_violation_moves):
            moved_any = False

            # Prioritize removing same-subject/day duplicates first.
            for violating_item in _subject_day_violation_items():
                week_key = violating_item.week_type or "base"
                if _try_relocate_item(violating_item, week_key, ""):
                    moved_any = True
                    break

            if moved_any:
                continue

            # Then reduce teacher daily overloads.
            for violating_item in _teacher_day_violation_items():
                week_key = violating_item.week_type or "base"
                if _try_relocate_item(violating_item, week_key, ""):
                    moved_any = True
                    break

            if not moved_any:
                break

        _rebuild_usage_maps()

        def _local_cp_sat_violation_repair() -> bool:
            violation_seed_items = _subject_day_violation_items() + _teacher_day_violation_items()
            if not violation_seed_items:
                return False

            affected_weeks: Set[str] = set()
            affected_classes: Set[str] = set()
            affected_teachers: Set[str] = set()
            affected_subjects: Set[str] = set()
            for seed_item in violation_seed_items:
                week_key = seed_item.week_type or "base"
                affected_weeks.add(week_key)
                affected_subjects.add(seed_item.subject_id)
                for class_id in seed_item.class_ids:
                    affected_classes.add(class_id)
                for teacher_id in _item_teacher_ids_for_rules(seed_item):
                    affected_teachers.add(teacher_id)

            movable_indices: List[int] = []
            for idx, scheduled_item in enumerate(working_items):
                if _is_block_item_for_rules(scheduled_item):
                    continue
                week_key = scheduled_item.week_type or "base"
                if week_key not in affected_weeks:
                    continue
                item_teacher_ids = set(_item_teacher_ids_for_rules(scheduled_item))
                if (
                    any(class_id in affected_classes for class_id in scheduled_item.class_ids)
                    or any(teacher_id in affected_teachers for teacher_id in item_teacher_ids)
                    or scheduled_item.subject_id in affected_subjects
                ):
                    movable_indices.append(idx)

            if not movable_indices:
                return False

            # Keep neighborhood bounded for stable runtime.
            movable_indices = movable_indices[:80]
            movable_index_set = set(movable_indices)

            fixed_class_slot_count: Dict[Tuple[str, str, str], int] = defaultdict(int)
            fixed_teacher_slot_count: Dict[Tuple[str, str, str], int] = defaultdict(int)
            fixed_teacher_day_count: Dict[Tuple[str, str, str], int] = defaultdict(int)
            fixed_subject_day_count: Dict[Tuple[str, str, str], int] = defaultdict(int)

            for idx, scheduled_item in enumerate(working_items):
                if idx in movable_index_set:
                    continue
                week_key = scheduled_item.week_type or "base"
                for class_id in scheduled_item.class_ids:
                    fixed_class_slot_count[(class_id, week_key, scheduled_item.timeslot_id)] += 1
                for teacher_id in _item_teacher_ids_for_rules(scheduled_item):
                    fixed_teacher_slot_count[(teacher_id, week_key, scheduled_item.timeslot_id)] += 1
                    fixed_teacher_day_count[(teacher_id, week_key, scheduled_item.day)] += 1
                fixed_subject_day_count[(scheduled_item.subject_id, week_key, scheduled_item.day)] += 1

            model = cp_model.CpModel()
            y: Dict[Tuple[int, str], cp_model.IntVar] = {}
            candidate_days: Dict[Tuple[int, str], str] = {}
            current_slot_by_index: Dict[int, str] = {}

            for idx in movable_indices:
                item = working_items[idx]
                week_key = item.week_type or "base"
                subject = subjects_by_id.get(item.subject_id)
                if not subject:
                    continue

                current_slot_by_index[idx] = item.timeslot_id
                item_units = _item_units(item, timeslot_units_map)

                allowed_slots = _compute_allowed_timeslots(
                    subject,
                    alternating_all_timeslot_ids,
                    alternating_block_to_timeslots,
                    alternating_timeslots_by_id,
                )
                allowed_weeks = _compute_allowed_weeks(
                    subject,
                    data.alternating_weeks_enabled,
                    blocks_by_id_for_rules,
                    linked_block_ids_for_rules,
                )

                candidate_slot_ids: Set[str] = {item.timeslot_id}
                if week_key in allowed_weeks:
                    for slot_id in allowed_slots:
                        if timeslot_units_map.get(slot_id, 1) != item_units:
                            continue

                        class_blocked = any(
                            slot_id in blocked_class_slots_by_week_for_rules.get((class_id, week_key), set())
                            for class_id in item.class_ids
                        )
                        if class_blocked and slot_id != item.timeslot_id:
                            continue

                        teacher_unavailable = False
                        for teacher_id in _item_teacher_ids_for_rules(item):
                            if teacher_id in alternating_teachers_by_id and slot_id in set(alternating_teachers_by_id[teacher_id].unavailable_timeslots):
                                teacher_unavailable = True
                                break
                            if slot_id in alternating_teacher_meeting_unavailable.get(teacher_id, set()):
                                teacher_unavailable = True
                                break
                        if teacher_unavailable and slot_id != item.timeslot_id:
                            continue

                        candidate_slot_ids.add(slot_id)

                slot_var_keys: List[Tuple[int, str]] = []
                for slot_id in sorted(candidate_slot_ids, key=_alternating_slot_sort_key):
                    key = (idx, slot_id)
                    y[key] = model.NewBoolVar(f"move_{idx}_{slot_id}")
                    slot_var_keys.append(key)
                    ts = alternating_timeslots_by_id[slot_id]
                    candidate_days[key] = ts.day

                if not slot_var_keys:
                    return False
                model.Add(sum(y[key] for key in slot_var_keys) == 1)

            if not y:
                return False

            # No class slot collisions.
            class_slot_keys: Set[Tuple[str, str, str]] = set(fixed_class_slot_count.keys())
            for idx in movable_indices:
                item = working_items[idx]
                week_key = item.week_type or "base"
                for slot_id in {slot for (item_idx, slot) in y if item_idx == idx}:
                    for class_id in item.class_ids:
                        class_slot_keys.add((class_id, week_key, slot_id))

            for class_id, week_key, slot_id in class_slot_keys:
                expr_terms = [
                    y[(idx, cand_slot)]
                    for (idx, cand_slot) in y
                    if (working_items[idx].week_type or "base") == week_key
                    and cand_slot == slot_id
                    and class_id in (working_items[idx].class_ids or [])
                ]
                model.Add(fixed_class_slot_count.get((class_id, week_key, slot_id), 0) + sum(expr_terms) <= 1)

            # No teacher slot collisions.
            teacher_slot_keys: Set[Tuple[str, str, str]] = set(fixed_teacher_slot_count.keys())
            for idx in movable_indices:
                item = working_items[idx]
                week_key = item.week_type or "base"
                item_teacher_ids = _item_teacher_ids_for_rules(item)
                for slot_id in {slot for (item_idx, slot) in y if item_idx == idx}:
                    for teacher_id in item_teacher_ids:
                        teacher_slot_keys.add((teacher_id, week_key, slot_id))

            for teacher_id, week_key, slot_id in teacher_slot_keys:
                expr_terms = [
                    y[(idx, cand_slot)]
                    for (idx, cand_slot) in y
                    if (working_items[idx].week_type or "base") == week_key
                    and cand_slot == slot_id
                    and teacher_id in _item_teacher_ids_for_rules(working_items[idx])
                ]
                model.Add(fixed_teacher_slot_count.get((teacher_id, week_key, slot_id), 0) + sum(expr_terms) <= 1)

            teacher_over_vars: List[cp_model.IntVar] = []
            for teacher_id in affected_teachers:
                for week_key in affected_weeks:
                    for day in DAY_ORDER_INDEX.keys():
                        expr_terms = [
                            y[(idx, cand_slot)]
                            for (idx, cand_slot) in y
                            if (working_items[idx].week_type or "base") == week_key
                            and teacher_id in _item_teacher_ids_for_rules(working_items[idx])
                            and candidate_days[(idx, cand_slot)].lower() == day
                        ]
                        if not expr_terms and fixed_teacher_day_count.get((teacher_id, week_key, day.title()), 0) == 0:
                            continue
                        over = model.NewIntVar(0, 10, f"teacher_over_{teacher_id}_{week_key}_{day}")
                        day_total = fixed_teacher_day_count.get((teacher_id, week_key, day.title()), 0) + sum(expr_terms)
                        model.Add(over >= day_total - 3)
                        teacher_over_vars.append(over)

            subject_over_vars: List[cp_model.IntVar] = []
            for subject_id in affected_subjects:
                subject = subjects_by_id.get(subject_id)
                if _is_norsk_vg3_subject(subject):
                    continue
                for week_key in affected_weeks:
                    for day in DAY_ORDER_INDEX.keys():
                        expr_terms = [
                            y[(idx, cand_slot)]
                            for (idx, cand_slot) in y
                            if working_items[idx].subject_id == subject_id
                            and (working_items[idx].week_type or "base") == week_key
                            and candidate_days[(idx, cand_slot)].lower() == day
                        ]
                        if not expr_terms and fixed_subject_day_count.get((subject_id, week_key, day.title()), 0) == 0:
                            continue
                        over = model.NewIntVar(0, 10, f"subject_over_{subject_id}_{week_key}_{day}")
                        day_total = fixed_subject_day_count.get((subject_id, week_key, day.title()), 0) + sum(expr_terms)
                        model.Add(over >= day_total - 1)
                        subject_over_vars.append(over)

            moved_vars: List[cp_model.IntVar] = []
            for idx in movable_indices:
                current_slot_id = current_slot_by_index.get(idx)
                if not current_slot_id or (idx, current_slot_id) not in y:
                    continue
                moved = model.NewBoolVar(f"moved_{idx}")
                model.Add(y[(idx, current_slot_id)] == 0).OnlyEnforceIf(moved)
                model.Add(y[(idx, current_slot_id)] == 1).OnlyEnforceIf(moved.Not())
                moved_vars.append(moved)

            model.Minimize(
                1000 * sum(teacher_over_vars)
                + 800 * sum(subject_over_vars)
                + 3 * sum(moved_vars)
            )

            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = 3.0
            solver.parameters.num_search_workers = max(1, min(8, os.cpu_count() or 1))
            status = solver.Solve(model)
            if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                return False

            changed = False
            for idx in movable_indices:
                chosen_slot_id = None
                for slot_id in {slot for (item_idx, slot) in y if item_idx == idx}:
                    if solver.Value(y[(idx, slot_id)]) == 1:
                        chosen_slot_id = slot_id
                        break
                if not chosen_slot_id:
                    continue

                item = working_items[idx]
                if item.timeslot_id == chosen_slot_id:
                    continue
                ts = alternating_timeslots_by_id[chosen_slot_id]
                item.timeslot_id = chosen_slot_id
                item.day = ts.day
                item.period = ts.period
                item.start_time = None
                item.end_time = None
                changed = True

            return changed

        if _local_cp_sat_violation_repair():
            _rebuild_usage_maps()

        return working_items, added_count

    def _success_response_with_hard_rules(response: ScheduleResponse) -> ScheduleResponse:
        if response.status != "success":
            return response

        repaired_schedule, repaired_count = _repair_missing_units(list(response.schedule or []))
        sanitized_schedule = _post_optimize_ab_day_uniqueness(
            data,
            repaired_schedule,
            timeslot_units_map,
        )
        sanitized_schedule = _assign_rooms_to_schedule(
            sanitized_schedule,
            data,
            {s.id: s for s in data.subjects},
            {cls.id: cls.base_room_id for cls in data.classes if cls.base_room_id},
        )
        subject_day_violations, teacher_day_violations = _hard_post_rule_violation_counts(sanitized_schedule)

        # Hard guard: keep required x45 totals exact for non-block subjects.
        placed_units_by_subject: Dict[str, int] = defaultdict(int)
        for item in sanitized_schedule:
            if item.subject_id in block_subject_ids:
                continue
            placed_units_by_subject[item.subject_id] += _item_units(item, timeslot_units_map)

        mismatches: List[Tuple[str, int, int]] = []
        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue
            weekly_units = max(0, int(subject.sessions_per_week or 0))
            expected_total = weekly_units * (2 if data.alternating_weeks_enabled else 1)
            actual_total = placed_units_by_subject.get(subject.id, 0)
            if actual_total != expected_total:
                mismatches.append((subject.id, expected_total, actual_total))

        if mismatches:
            preview = ", ".join(
                f"{subject_id}: exp={expected}u act={actual}u"
                for subject_id, expected, actual in mismatches[:5]
            )
            return ScheduleResponse(
                status="infeasible",
                message=(
                    "Rejected schedule because required x45 totals are not exact for one or more subjects. "
                    f"Examples: {preview}."
                ),
                schedule=sanitized_schedule,
                metadata=dict(response.metadata or {}),
            )

        if subject_day_violations > 0 or teacher_day_violations > 0:
            return ScheduleResponse(
                status="infeasible",
                message=(
                    "Rejected schedule because hard placement rules were violated after repair "
                    f"(subject-day: {subject_day_violations}, teacher-day: {teacher_day_violations})."
                ),
                schedule=sanitized_schedule,
                metadata=dict(response.metadata or {}),
            )

        message = response.message
        if repaired_count > 0:
            message = f"{message} Repaired {repaired_count} missing placements while preserving x45 totals."
        return ScheduleResponse(
            status="success",
            message=message,
            schedule=sanitized_schedule,
            metadata=dict(response.metadata or {}),
        )

    def _alternating_slot_sort_key(ts_id: str) -> Tuple[str, int]:
        ts = alternating_timeslots_by_id[ts_id]
        return (ts.day, ts.period)

    def _odd_subject_can_hit_exact_week_units(subject: Subject) -> bool:
        target_units = max(0, int(subject.sessions_per_week or 0))
        if target_units <= 0:
            return True

        allowed_slots = _compute_allowed_timeslots(
            subject,
            alternating_all_timeslot_ids,
            alternating_block_to_timeslots,
            alternating_timeslots_by_id,
        )

        teacher_ids = alternating_subject_teacher_ids.get(subject.id, _subject_teacher_ids(subject))
        for teacher_id in teacher_ids:
            if teacher_id in alternating_teachers_by_id:
                allowed_slots -= set(alternating_teachers_by_id[teacher_id].unavailable_timeslots)
            allowed_slots -= alternating_teacher_meeting_unavailable.get(teacher_id, set())

        reachable_units: Set[int] = {0}
        for ts_id in sorted(allowed_slots, key=_alternating_slot_sort_key):
            slot_units = alternating_timeslot_units_by_id.get(ts_id, 1)
            additions = {
                used_units + slot_units
                for used_units in reachable_units
                if used_units + slot_units <= target_units
            }
            reachable_units |= additions
            if target_units in reachable_units:
                return True

        return target_units in reachable_units

    odd_subject_needs_oriented_split: Set[str] = {
        subject.id
        for subject in data.subjects
        if subject.id in auto_balanced_odd_subject_ids
        and not _odd_subject_can_hit_exact_week_units(subject)
    }

    def _build_partial_odd_subject_ids(strategy: str) -> Set[str]:
        if strategy == "all_partial":
            return set(auto_balanced_odd_subject_ids)

        # Alternate A-heavy/B-heavy odd subjects per class bucket.
        # A-heavy subjects are not marked partial in A-week; B-heavy are partial.
        if strategy == "alternate_heavy":
            bucketed: Dict[str, List[Subject]] = defaultdict(list)
            odd_by_id = {s.id: s for s in data.subjects if s.id in auto_balanced_odd_subject_ids}
            for subject in odd_by_id.values():
                bucket = subject.class_ids[0] if subject.class_ids else "__global__"
                bucketed[bucket].append(subject)

            a_heavy_ids: Set[str] = set()
            for subjects_in_bucket in bucketed.values():
                subjects_in_bucket.sort(
                    key=lambda s: (int(s.sessions_per_week or 1), s.name.lower(), s.id)
                )
                for idx, subject in enumerate(subjects_in_bucket):
                    if idx % 2 == 0:
                        a_heavy_ids.add(subject.id)

            return set(auto_balanced_odd_subject_ids) - a_heavy_ids

        return set(auto_balanced_odd_subject_ids)

    def _build_odd_heavy_week_by_subject(strategy: str, odd_order_variant: int) -> Dict[str, str]:
        if strategy != "alternate_heavy":
            return {}

        bucketed: Dict[str, List[Subject]] = defaultdict(list)
        for subject in data.subjects:
            if subject.id not in odd_subject_needs_oriented_split:
                continue
            bucket = subject.class_ids[0] if subject.class_ids else "__global__"
            bucketed[bucket].append(subject)

        heavy_week_by_subject: Dict[str, str] = {}
        for subjects_in_bucket in bucketed.values():
            ordered_subjects = sorted(
                subjects_in_bucket,
                key=lambda s: (int(s.sessions_per_week or 1), s.name.lower(), s.id),
            )
            if ordered_subjects:
                if odd_order_variant == 1:
                    ordered_subjects = list(reversed(ordered_subjects))
                elif odd_order_variant == 2:
                    ordered_subjects = ordered_subjects[1:] + ordered_subjects[:1]
                elif odd_order_variant >= 3:
                    seeded_subjects = list(ordered_subjects)
                    random.Random(23_911 + odd_order_variant * 4_321).shuffle(seeded_subjects)
                    ordered_subjects = seeded_subjects

            start_week = "A" if (odd_order_variant % 2) == 0 else "B"
            for idx, subject in enumerate(ordered_subjects):
                if start_week == "A":
                    heavy_week_by_subject[subject.id] = "A" if idx % 2 == 0 else "B"
                else:
                    heavy_week_by_subject[subject.id] = "B" if idx % 2 == 0 else "A"

        return heavy_week_by_subject

    def _schedule_quality(items: List[ScheduledItem]) -> int:
        subjects_by_id = {s.id: s for s in data.subjects}
        class_units_by_week: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        total_units_by_week: Counter[str] = Counter()
        for item in items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            item_units = _item_units(item, timeslot_units_map)
            total_units_by_week[week] += item_units
            for class_id in item.class_ids:
                class_units_by_week[class_id][week] += item_units

        class_ab_imbalance = 0
        max_class_imbalance = 0
        class_target_deviation = 0
        for class_id, week_units in class_units_by_week.items():
            a_units = week_units.get("A", 0)
            b_units = week_units.get("B", 0)
            imbalance = abs(a_units - b_units)
            class_ab_imbalance += imbalance
            max_class_imbalance = max(max_class_imbalance, imbalance)

            target_units = nominal_target_units_by_class.get(class_id)
            if target_units is not None:
                class_target_deviation += abs(a_units - target_units) + abs(b_units - target_units)

        global_ab_imbalance = abs(total_units_by_week.get("A", 0) - total_units_by_week.get("B", 0))
        reduced_tail_mismatch_penalty = _reduced_tail_ab_mismatch_penalty(items, timeslot_units_map)

        return (
            class_target_deviation * 20_000
            + global_ab_imbalance * 10_000
            + max_class_imbalance * 2_000
            + class_ab_imbalance * 1_000
            + reduced_tail_mismatch_penalty * 600
            +
            _odd_subject_unmatched_split_penalty(items, subjects_by_id) * 1000
            + _subject_day_repeat_penalty(items, subjects_by_id) * 100
            - _norsk_vg3_adjacent_double90_pairs(
                items,
                subjects_by_id,
                {t.id: t for t in data.timeslots},
                timeslot_units_map,
            ) * 5
        )

    def _hard_ab_balance_ok(items: List[ScheduledItem]) -> Tuple[bool, str]:
        units_by_subject_week: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        items_by_subject: Dict[str, List[ScheduledItem]] = defaultdict(list)
        for item in items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            units_by_subject_week[item.subject_id][week] += _item_units(item, timeslot_units_map)
            items_by_subject[item.subject_id].append(item)

        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue

            nominal = int(subject.sessions_per_week or 1)
            a_units = units_by_subject_week[subject.id].get("A", 0)
            b_units = units_by_subject_week[subject.id].get("B", 0)

            # Hard two-week conservation.
            if a_units + b_units != 2 * nominal:
                return (
                    False,
                    f"Hard A/B load violated for '{subject.name}' ({subject.id}): "
                    f"A={a_units}u, B={b_units}u, expected total {2 * nominal}u.",
                )

            # Hard per-week bound: each week can differ by at most 1 from nominal.
            lo = max(0, nominal - 1)
            hi = nominal + 1
            if a_units < lo or a_units > hi or b_units < lo or b_units > hi:
                return (
                    False,
                    f"Hard A/B load violated for '{subject.name}' ({subject.id}): "
                    f"A={a_units}u, B={b_units}u, allowed range per week [{lo}u, {hi}u].",
                )

            # Hard same-session pairing rule across A/B:
            # even subjects must pair all signatures; odd subjects may have one unmatched.
            a_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
            b_counts: Dict[Tuple[str, str, int, str | None, str | None], int] = defaultdict(int)
            for item in items_by_subject.get(subject.id, []):
                wk = item.week_type or "base"
                if wk not in {"A", "B"}:
                    continue
                sig = (item.timeslot_id, item.day, item.period, item.start_time, item.end_time)
                if wk == "A":
                    a_counts[sig] += 1
                else:
                    b_counts[sig] += 1

            matched = 0
            for sig in set(a_counts.keys()) | set(b_counts.keys()):
                matched += min(a_counts.get(sig, 0), b_counts.get(sig, 0))

            total_items = sum(a_counts.values()) + sum(b_counts.values())
            unmatched = total_items - 2 * matched
            allowed_unmatched = 1 if (nominal % 2 == 1) else 0
            if unmatched > allowed_unmatched:
                return (
                    False,
                    f"Hard A/B signature pairing violated for '{subject.name}' ({subject.id}): "
                    f"unmatched signatures={unmatched}, allowed={allowed_unmatched}.",
                )

        return True, ""

    def _target_units_for_week(
        subject: Subject,
        week_label: str,
        odd_split_mode: str,
        odd_heavy_week_by_subject: Dict[str, str],
    ) -> int:
        if week_label == "A" and subject.id in explicit_a_overrides:
            return max(0, int(explicit_a_overrides[subject.id]))
        if week_label == "B" and subject.id in explicit_b_overrides:
            return max(0, int(explicit_b_overrides[subject.id]))

        base_units = int(subject.sessions_per_week or 1)
        if subject.id not in auto_balanced_odd_subject_ids or subject.id in block_subject_ids:
            return max(0, base_units)
        if odd_split_mode == "balanced":
            preferred_heavy_week = odd_heavy_week_by_subject.get(subject.id)
            if preferred_heavy_week in {"A", "B"}:
                return max(0, base_units + 1 if week_label == preferred_heavy_week else base_units - 1)
            return max(0, base_units)
        if odd_split_mode == "a_heavy":
            return max(0, base_units + 1 if week_label == "A" else base_units - 1)
        return max(0, base_units - 1 if week_label == "A" else base_units + 1)

    def _desired_units_for_secondary_week(
        subject: Subject,
        primary_placed_units: int,
        secondary_week_label: str,
        odd_split_mode: str,
        odd_heavy_week_by_subject: Dict[str, str],
    ) -> int:
        if subject.id in odd_heavy_week_by_subject or odd_split_mode in {"a_heavy", "a_light"}:
            return _target_units_for_week(
                subject,
                secondary_week_label,
                odd_split_mode,
                odd_heavy_week_by_subject,
            )

        nominal_units = max(0, int(subject.sessions_per_week or 1))
        # Keep even-load subjects symmetric across A/B.
        # Dynamic two-week compensation is only needed for odd loads.
        if nominal_units % 2 == 0:
            return nominal_units

        total_two_week = 2 * nominal_units
        return max(0, total_two_week - primary_placed_units)

    reduced_tail_fallback_by_subject: Dict[str, bool] = {}

    def _subject_has_both_week_reduced_tail_capacity(subject_id: str) -> bool:
        cached = reduced_tail_fallback_by_subject.get(subject_id)
        if cached is not None:
            return cached

        subject = next((s for s in data.subjects if s.id == subject_id), None)
        if (
            not subject
            or subject.id not in auto_balanced_odd_subject_ids
            or subject.id in block_subject_ids
            or not subject.class_ids
        ):
            reduced_tail_fallback_by_subject[subject_id] = False
            return False

        teacher_ids = alternating_subject_teacher_ids.get(subject.id, _subject_teacher_ids(subject))

        def _reduced_tail_slots_for_week(week_label: str) -> Set[str]:
            allowed_slots = _compute_allowed_timeslots(
                subject,
                alternating_all_timeslot_ids,
                alternating_block_to_timeslots,
                alternating_timeslots_by_id,
            )

            for teacher_id in teacher_ids:
                if teacher_id in alternating_teachers_by_id:
                    allowed_slots -= set(alternating_teachers_by_id[teacher_id].unavailable_timeslots)
                allowed_slots -= alternating_teacher_meeting_unavailable.get(teacher_id, set())

            reduced_tail_by_class_slot: Set[Tuple[str, str]] = set()
            for block in data.blocks:
                if not block.class_ids:
                    continue
                for occ in block.occurrences:
                    occ_week = (occ.week_type or "both").upper()
                    if occ_week not in {"BOTH", week_label}:
                        continue

                    matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots) & alternating_all_timeslot_ids
                    occ_start = _to_minutes(occ.start_time)
                    occ_end = _to_minutes(occ.end_time)
                    if occ_start is None or occ_end is None:
                        continue

                    for ts_id in matched_slots:
                        ts = alternating_timeslots_by_id.get(ts_id)
                        if not ts:
                            continue
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

                        for class_id in block.class_ids:
                            reduced_tail_by_class_slot.add((class_id, ts_id))

            return {
                ts_id
                for ts_id in allowed_slots
                if all((class_id, ts_id) in reduced_tail_by_class_slot for class_id in subject.class_ids)
            }

        result = bool(_reduced_tail_slots_for_week("A")) and bool(_reduced_tail_slots_for_week("B"))
        reduced_tail_fallback_by_subject[subject_id] = result
        return result

    def _run_alternating_attempt(
        primary_week_label: str,
        partial_priority: str,
        enforce_odd_min_a: bool,
        odd_strategy: str,
        odd_order_variant: int,
        odd_split_mode: str,
        exact_week_subject_ids: Set[str] | None = None,
    ) -> ScheduleResponse:
        exact_week_subject_ids = set(exact_week_subject_ids or set())
        secondary_week_label = "B" if primary_week_label == "A" else "A"
        odd_heavy_week_by_subject = _build_odd_heavy_week_by_subject(odd_strategy, odd_order_variant)
        # Try both odd-subject orientations:
        # - "balanced": A gets sessions, B gets sessions (preferred)
        # - "a_light": A gets (sessions-1), B gets (sessions+1)
        # - "a_heavy": A gets (sessions+1), B gets (sessions-1)
        primary_week_overrides: Dict[str, int] = dict(
            explicit_a_overrides if primary_week_label == "A" else explicit_b_overrides
        )
        for subj in data.subjects:
            if subj.id in auto_balanced_odd_subject_ids and subj.id not in block_subject_ids:
                if subj.id in exact_week_subject_ids:
                    primary_week_overrides[subj.id] = max(0, int(subj.sessions_per_week or 1))
                    continue
                primary_week_overrides[subj.id] = _target_units_for_week(
                    subj,
                    primary_week_label,
                    odd_split_mode,
                    odd_heavy_week_by_subject,
                )

        # Relaxed attempts may allow odd subjects to underfill A when strict feasibility fails.
        partial_odd_subject_ids = _build_partial_odd_subject_ids(odd_strategy) if not enforce_odd_min_a else set()
        partial_min_units_primary: Dict[str, int] = {}
        if partial_odd_subject_ids:
            for subj in data.subjects:
                if subj.id in partial_odd_subject_ids and subj.id not in block_subject_ids:
                    partial_min_units_primary[subj.id] = max(0, int(subj.sessions_per_week or 1) - 1)

        odd_subject_ids_for_order = [s.id for s in data.subjects if s.id in auto_balanced_odd_subject_ids]
        odd_subject_ids_for_order.sort()
        if odd_subject_ids_for_order:
            if odd_order_variant == 1:
                odd_subject_ids_for_order = list(reversed(odd_subject_ids_for_order))
            elif odd_order_variant == 2:
                odd_subject_ids_for_order = odd_subject_ids_for_order[1:] + odd_subject_ids_for_order[:1]
            elif odd_order_variant >= 3:
                # Deterministic shuffle variants to explore additional placement orders.
                seeded = list(odd_subject_ids_for_order)
                random.Random(17_171 + odd_order_variant * 9_973).shuffle(seeded)
                odd_subject_ids_for_order = seeded
        subject_rank = {sid: i for i, sid in enumerate(odd_subject_ids_for_order)}

        response_primary = _generate_schedule_staged(
            data,
            week_label=primary_week_label,
            week_unit_overrides=primary_week_overrides or None,
            allow_partial_subject_ids=(partial_odd_subject_ids or None),
            partial_min_units_by_subject=(partial_min_units_primary or None),
            partial_subject_priority=partial_priority,
            subject_priority_rank=subject_rank,
            target_week_units_by_class=nominal_target_units_by_class,
        )
        if response_primary.status != "success":
            failed_subject_match = re.search(r"\(([^)]+)\)", response_primary.message or "")
            failed_subject_id = failed_subject_match.group(1) if failed_subject_match else None

            # Retry once with a relaxed primary-week target for the failing odd subject.
            # This keeps alternating-week generation alive and lets the opposite week
            # absorb the extra odd-unit load (e.g. 2u + 4u) instead of hard-failing early.
            if failed_subject_id and failed_subject_id in auto_balanced_odd_subject_ids and failed_subject_id not in block_subject_ids:
                failed_subject = next((s for s in data.subjects if s.id == failed_subject_id), None)
                if failed_subject is not None:
                    relaxed_primary_overrides = dict(primary_week_overrides)
                    relaxed_target = max(0, int(failed_subject.sessions_per_week or 1) - 1)
                    relaxed_primary_overrides[failed_subject_id] = relaxed_target

                    response_primary_relaxed = _generate_schedule_staged(
                        data,
                        week_label=primary_week_label,
                        week_unit_overrides=relaxed_primary_overrides or None,
                        allow_partial_subject_ids={failed_subject_id},
                        partial_min_units_by_subject={failed_subject_id: relaxed_target},
                        partial_subject_priority=partial_priority,
                        subject_priority_rank=subject_rank,
                        target_week_units_by_class=nominal_target_units_by_class,
                    )
                    if response_primary_relaxed.status == "success":
                        response_primary = response_primary_relaxed

            if response_primary.status != "success":
                failed_subject_match = re.search(r"\(([^)]+)\)", response_primary.message or "")
                failed_subject_id = failed_subject_match.group(1) if failed_subject_match else None
            if (
                not exact_week_subject_ids
                and failed_subject_id
                and _subject_has_both_week_reduced_tail_capacity(failed_subject_id)
            ):
                return _run_alternating_attempt(
                    primary_week_label,
                    partial_priority,
                    enforce_odd_min_a,
                    odd_strategy,
                    odd_order_variant,
                    odd_split_mode,
                    {failed_subject_id},
                )

            metadata = dict(response_primary.metadata or {})
            partial_primary_schedule = list(response_primary.schedule or [])
            has_primary_week_items = any(
                (item.week_type or "base") == primary_week_label
                for item in partial_primary_schedule
            )
            metadata[f"failed_week_{primary_week_label.lower()}"] = 0.0 if has_primary_week_items else 1.0
            if partial_primary_schedule:
                metadata["partial"] = 1.0
                metadata["placed_count"] = float(len(partial_primary_schedule))
            return ScheduleResponse(
                status=response_primary.status,
                message=(
                    f"{primary_week_label}-week: {response_primary.message}"
                    if not partial_primary_schedule
                    else (
                        f"{primary_week_label}-week: {response_primary.message}"
                    )
                ),
                schedule=partial_primary_schedule,
                metadata=metadata,
            )

        subject_items_in_primary: Dict[str, List[ScheduledItem]] = defaultdict(list)
        primary_placed: Dict[str, int] = defaultdict(int)
        for item in response_primary.schedule:
            subject_items_in_primary[item.subject_id].append(item)
            if item.subject_id not in block_subject_ids:
                primary_placed[item.subject_id] += _item_units(item, timeslot_units_map)

        mirrored_fellesfag_subject_ids: Set[str] = set()
        for subj in data.subjects:
            if subj.subject_type != "fellesfag" or subj.id in block_subject_ids:
                continue
            nominal_units = max(0, int(subj.sessions_per_week or 0))
            if nominal_units % 2 == 1:
                continue
            allowed_weeks = _compute_allowed_weeks(
                subj,
                True,
                blocks_by_id_for_rules,
                linked_block_ids_for_rules,
            )
            if {"A", "B"}.issubset(allowed_weeks):
                mirrored_fellesfag_subject_ids.add(subj.id)

        seeded_secondary_items: List[ScheduledItem] = []
        mirrored_secondary_units_by_subject: Dict[str, int] = defaultdict(int)
        primary_slots_by_class: Dict[str, Set[str]] = defaultdict(set)
        primary_slots_by_subject: Dict[str, Set[str]] = defaultdict(set)
        primary_units_by_class: Dict[str, int] = defaultdict(int)
        for item in response_primary.schedule:
            item_units = _item_units(item, timeslot_units_map)
            primary_slots_by_subject[item.subject_id].add(item.timeslot_id)
            for class_id in item.class_ids:
                primary_slots_by_class[class_id].add(item.timeslot_id)
                primary_units_by_class[class_id] += item_units

        secondary_blocked_slots_by_class: Dict[str, Set[str]] = defaultdict(set)
        for block in data.blocks:
            if not block.class_ids:
                continue

            if block.occurrences:
                for occ in block.occurrences:
                    occ_week = (occ.week_type or "both").upper()
                    if occ_week not in {"BOTH", secondary_week_label}:
                        continue
                    matched_slots = _timeslots_overlapping_occurrence(occ, data.timeslots) & alternating_all_timeslot_ids
                    for class_id in block.class_ids:
                        secondary_blocked_slots_by_class[class_id].update(matched_slots)
                continue

            legacy_weeks = _block_active_weeks(block, True)
            if secondary_week_label not in legacy_weeks:
                continue
            matched_slots = set(block.timeslot_ids) & alternating_all_timeslot_ids
            for class_id in block.class_ids:
                secondary_blocked_slots_by_class[class_id].update(matched_slots)

        for subj in data.subjects:
            if subj.id in block_subject_ids:
                continue

            subject_items = sorted(
                subject_items_in_primary.get(subj.id, []),
                key=lambda item: (item.day, item.period, item.start_time or "", item.end_time or ""),
            )
            if not subject_items:
                continue

            if subj.id in mirrored_fellesfag_subject_ids:
                # Keep non-block fellesfag mirrored across A/B in staged generation.
                lock_units = primary_placed.get(subj.id, 0)
            else:
                secondary_target_units = _desired_units_for_secondary_week(
                    subj,
                    primary_placed.get(subj.id, 0),
                    secondary_week_label,
                    odd_split_mode,
                    odd_heavy_week_by_subject,
                )
                lock_units = min(primary_placed.get(subj.id, 0), secondary_target_units)

            locked_units = 0
            for item in subject_items:
                item_units = _item_units(item, timeslot_units_map)
                if locked_units + item_units > lock_units:
                    continue
                if any(
                    item.timeslot_id in secondary_blocked_slots_by_class.get(class_id, set())
                    for class_id in item.class_ids
                ):
                    continue
                seeded_secondary_items.append(
                    ScheduledItem(
                        subject_id=item.subject_id,
                        subject_name=item.subject_name,
                        teacher_id=item.teacher_id,
                        teacher_ids=item.teacher_ids,
                        class_ids=item.class_ids,
                        timeslot_id=item.timeslot_id,
                        day=item.day,
                        period=item.period,
                        start_time=item.start_time,
                        end_time=item.end_time,
                        week_type=secondary_week_label,
                        room_id=item.room_id,
                    )
                )
                locked_units += item_units
                mirrored_secondary_units_by_subject[subj.id] += item_units
                if locked_units >= lock_units:
                    break

        secondary_overrides: Dict[str, int] = dict(
            explicit_b_overrides if secondary_week_label == "B" else explicit_a_overrides
        )
        for subj in data.subjects:
            if subj.id in block_subject_ids:
                continue
            if subj.id in secondary_overrides:
                continue
            if subj.id in mirrored_fellesfag_subject_ids:
                secondary_overrides[subj.id] = mirrored_secondary_units_by_subject.get(subj.id, 0)
                continue
            if subj.id in exact_week_subject_ids:
                secondary_overrides[subj.id] = max(0, int(subj.sessions_per_week or 1))
                continue
            secondary_overrides[subj.id] = _desired_units_for_secondary_week(
                subj,
                primary_placed.get(subj.id, 0),
                secondary_week_label,
                odd_split_mode,
                odd_heavy_week_by_subject,
            )

        response_secondary = _generate_schedule_staged(
            data,
            week_label=secondary_week_label,
            week_unit_overrides=secondary_overrides or None,
            seed_items=seeded_secondary_items,
            cross_week_preferred_slots_by_class=primary_slots_by_class,
            cross_week_preferred_slots_by_subject=primary_slots_by_subject,
            partial_subject_priority=partial_priority,
            subject_priority_rank=subject_rank,
            target_week_units_by_class=nominal_target_units_by_class,
        )
        if response_secondary.status != "success":
            failed_subject_id: str | None = None
            failed_required_units: int | None = None
            failed_placed_units: int | None = None

            m_id = re.search(r"\(([^)]+)\)", response_secondary.message or "")
            if m_id:
                failed_subject_id = m_id.group(1)
            m_req = re.search(r"Required\s+(\d+)u", response_secondary.message or "")
            if m_req:
                failed_required_units = int(m_req.group(1))
            m_placed = re.search(r"placed\s+(\d+)u", response_secondary.message or "")
            if m_placed:
                failed_placed_units = int(m_placed.group(1))

            # Retry 1: remove seeded B items for the failing subject so B can place it more freely.
            if failed_subject_id and failed_subject_id in secondary_overrides and failed_subject_id not in mirrored_fellesfag_subject_ids:
                retry_seed_items = [it for it in seeded_secondary_items if it.subject_id != failed_subject_id]
                response_secondary_retry = _generate_schedule_staged(
                    data,
                    week_label=secondary_week_label,
                    week_unit_overrides=secondary_overrides or None,
                    seed_items=retry_seed_items,
                    cross_week_preferred_slots_by_class=primary_slots_by_class,
                    cross_week_preferred_slots_by_subject=primary_slots_by_subject,
                    partial_subject_priority=partial_priority,
                    subject_priority_rank=subject_rank,
                    target_week_units_by_class=nominal_target_units_by_class,
                )
                if response_secondary_retry.status == "success":
                    response_secondary = response_secondary_retry

            # Retry 2: controlled partial fallback for the same subject only.
            # Keep at least currently achievable units (or required-2 when parsing is unavailable).
            if (
                response_secondary.status != "success"
                and failed_subject_id
                and failed_subject_id in secondary_overrides
                and failed_subject_id not in mirrored_fellesfag_subject_ids
            ):
                target_required = int(secondary_overrides.get(failed_subject_id, 0))
                failed_subject = next((s for s in data.subjects if s.id == failed_subject_id), None)
                if failed_subject is not None:
                    nominal = int(failed_subject.sessions_per_week or 1)
                    # For odd-unit subjects, ensure at least nominal-1 per week to maintain A/B balance.
                    # This prevents odd subjects from being completely missing from one week.
                    if nominal % 2 == 1:
                        min_units = max(0, nominal - 1)
                    else:
                        min_units = max(0, target_required - 2)
                else:
                    min_units = max(0, target_required - 2)
                
                if failed_placed_units is not None:
                    min_units = max(min_units, failed_placed_units)
                if failed_required_units is not None and failed_required_units < target_required:
                    min_units = min(min_units, failed_required_units)

                response_secondary_partial = _generate_schedule_staged(
                    data,
                    week_label=secondary_week_label,
                    week_unit_overrides=secondary_overrides or None,
                    seed_items=[it for it in seeded_secondary_items if it.subject_id != failed_subject_id],
                    cross_week_preferred_slots_by_class=primary_slots_by_class,
                    cross_week_preferred_slots_by_subject=primary_slots_by_subject,
                    allow_partial_subject_ids={failed_subject_id},
                    partial_min_units_by_subject={failed_subject_id: min_units},
                    partial_subject_priority=partial_priority,
                    subject_priority_rank=subject_rank,
                    target_week_units_by_class=nominal_target_units_by_class,
                )
                if response_secondary_partial.status == "success":
                    response_secondary = response_secondary_partial

        if response_secondary.status != "success":
            retry_subject_match = re.search(r"\(([^)]+)\)", response_secondary.message or "")
            retry_subject_id = retry_subject_match.group(1) if retry_subject_match else None
            if (
                not exact_week_subject_ids
                and retry_subject_id
                and _subject_has_both_week_reduced_tail_capacity(retry_subject_id)
            ):
                return _run_alternating_attempt(
                    primary_week_label,
                    partial_priority,
                    enforce_odd_min_a,
                    odd_strategy,
                    odd_order_variant,
                    odd_split_mode,
                    {retry_subject_id},
                )

            combined_partial_schedule = response_primary.schedule + response_secondary.schedule
            combined_partial_schedule = _mirror_reduced_tail_for_partial_weeks(
                data,
                combined_partial_schedule,
                timeslot_units_map,
            )
            combined_partial_schedule = _fill_reduced_tail_shortage_for_partial_weeks(
                data,
                combined_partial_schedule,
                timeslot_units_map,
            )
            combined_partial_schedule = _rebalance_1tmt_naturfag_samf_partial(
                data,
                combined_partial_schedule,
            )
            combined_partial_schedule = _assign_rooms_to_schedule(
                combined_partial_schedule,
                data,
                {s.id: s for s in data.subjects},
                {cls.id: cls.base_room_id for cls in data.classes if cls.base_room_id},
            )
            metadata = dict(response_secondary.metadata or {})
            if combined_partial_schedule:
                metadata["partial"] = 1.0
                metadata["placed_count"] = float(len(combined_partial_schedule))
            has_week_a = any((item.week_type or "base") == "A" for item in combined_partial_schedule)
            has_week_b = any((item.week_type or "base") == "B" for item in combined_partial_schedule)
            metadata["failed_week_a"] = 0.0 if has_week_a else 1.0
            metadata["failed_week_b"] = 0.0 if has_week_b else 1.0

            if combined_partial_schedule:
                return _success_response_with_hard_rules(ScheduleResponse(
                    status="success",
                    message=(
                        "Schedule generated with current constraints. "
                        f"{secondary_week_label}-week could not place all preferred units."
                    ),
                    schedule=combined_partial_schedule,
                    metadata=metadata,
                ))

            return ScheduleResponse(
                status=response_secondary.status,
                message=f"{secondary_week_label}-week: {response_secondary.message}",
                schedule=combined_partial_schedule,
                metadata=metadata,
            )

        combined_schedule = response_primary.schedule + response_secondary.schedule
        combined_schedule = _post_optimize_ab_day_uniqueness(
            data,
            combined_schedule,
            timeslot_units_map,
        )

        hard_ok, hard_message = _hard_ab_balance_ok(combined_schedule)
        if not hard_ok:
            return ScheduleResponse(
                status="infeasible",
                message=hard_message,
                schedule=[],
            )

        combined_schedule = _assign_rooms_to_schedule(
            combined_schedule,
            data,
            {s.id: s for s in data.subjects},
            {cls.id: cls.base_room_id for cls in data.classes if cls.base_room_id},
        )

        return _success_response_with_hard_rules(ScheduleResponse(
            status="success",
            message="Schedule generated for A and B weeks.",
            schedule=combined_schedule,
        ))

    attempts: List[ScheduleResponse] = []
    failures: List[ScheduleResponse] = []

    # Keep alternating search focused on balanced A/B behavior first.
    # For odd loads under coarse slot granularity (e.g. 2x45), also try both
    # orientations so the extra unit can land in either week instead of
    # consistently favoring A-week.
    attempt_configs: List[Tuple[str, str, bool, str, int, str]] = [
        ("A", "first", True, "alternate_heavy", 0, "balanced"),
        ("B", "first", True, "alternate_heavy", 0, "balanced"),
        ("A", "first", True, "alternate_heavy", 0, "a_light"),
        ("B", "first", True, "alternate_heavy", 0, "a_light"),
        ("A", "first", True, "alternate_heavy", 0, "a_heavy"),
        ("B", "first", True, "alternate_heavy", 0, "a_heavy"),
        ("A", "first", True, "alternate_heavy", 1, "balanced"),
        ("B", "first", True, "alternate_heavy", 1, "balanced"),
        ("A", "first", True, "alternate_heavy", 3, "balanced"),
        ("B", "first", True, "alternate_heavy", 3, "balanced"),
        ("A", "last", True, "alternate_heavy", 0, "balanced"),
        ("B", "last", True, "alternate_heavy", 0, "balanced"),
        ("A", "first", True, "all_partial", 0, "balanced"),
        ("B", "first", True, "all_partial", 0, "balanced"),
        ("A", "first", True, "all_partial", 3, "balanced"),
        ("B", "first", True, "all_partial", 3, "balanced"),
        ("A", "first", False, "alternate_heavy", 0, "balanced"),
        ("B", "first", False, "alternate_heavy", 0, "balanced"),
        ("A", "first", False, "alternate_heavy", 3, "balanced"),
        ("B", "first", False, "alternate_heavy", 3, "balanced"),
        ("A", "first", False, "all_partial", 0, "balanced"),
        ("B", "first", False, "all_partial", 0, "balanced"),
    ]

    # Reiterate with new shuffle seeds until we find a hard-valid solution.
    max_search_rounds = 8
    for search_round in range(max_search_rounds):
        # Stop only after we have at least one hard-valid candidate.
        if attempts:
            break

        round_attempt_configs: List[Tuple[str, str, bool, str, int, str]] = []
        for primary_week_label, partial_priority, enforce_odd_min_a, odd_strategy, odd_order_variant, odd_split_mode in attempt_configs:
            # Keep fixed-order variants in round 0; for shuffled variants (>=3),
            # mutate seed space each round to explore more orderings.
            if odd_order_variant < 3:
                if search_round == 0:
                    round_attempt_configs.append(
                        (primary_week_label, partial_priority, enforce_odd_min_a, odd_strategy, odd_order_variant, odd_split_mode)
                    )
                continue

            varied_variant = odd_order_variant + (search_round * 37)
            round_attempt_configs.append(
                (primary_week_label, partial_priority, enforce_odd_min_a, odd_strategy, varied_variant, odd_split_mode)
            )

        if not round_attempt_configs:
            continue

        max_workers = min(len(round_attempt_configs), max(2, (os.cpu_count() or 2)))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {
                executor.submit(
                    _run_alternating_attempt,
                    primary_week_label,
                    partial_priority,
                    enforce_odd_min_a,
                    odd_strategy,
                    odd_order_variant,
                    odd_split_mode,
                ): (primary_week_label, partial_priority, enforce_odd_min_a, odd_strategy, odd_order_variant, odd_split_mode)
                for primary_week_label, partial_priority, enforce_odd_min_a, odd_strategy, odd_order_variant, odd_split_mode in round_attempt_configs
            }

            for future in as_completed(future_map):
                attempt = future.result()
                if attempt.status == "success":
                    validated_attempt = _success_response_with_hard_rules(attempt)
                    a_units = sum(_item_units(item, timeslot_units_map) for item in attempt.schedule if (item.week_type or "base") == "A")
                    b_units = sum(_item_units(item, timeslot_units_map) for item in attempt.schedule if (item.week_type or "base") == "B")
                    config = future_map[future]
                    if validated_attempt.status == "success":
                        _solver_log(
                            "[ALT-SUCCESS] config="
                            f"{config} quality={_schedule_quality(validated_attempt.schedule)} "
                            f"a_units={a_units} b_units={b_units} items={len(validated_attempt.schedule)}"
                        )
                        attempts.append(validated_attempt)
                    else:
                        _solver_log(
                            "[ALT-REJECTED] config="
                            f"{config} status={validated_attempt.status} message={validated_attempt.message}"
                        )
                        failures.append(validated_attempt)
                else:
                    config = future_map[future]
                    _solver_log(
                        "[ALT-FAIL] config="
                        f"{config} status={attempt.status} message={attempt.message}"
                    )
                    failures.append(attempt)

    def _response_total_shortage_units(response: ScheduleResponse) -> int:
        items = response.schedule or []
        units_by_subject: Dict[str, int] = defaultdict(int)
        for item in items:
            week = item.week_type or "base"
            if week not in {"A", "B"}:
                continue
            units_by_subject[item.subject_id] += _item_units(item, timeslot_units_map)

        shortage = 0
        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue
            expected_units = max(0, 2 * int(subject.sessions_per_week or 1))
            placed_units = units_by_subject.get(subject.id, 0)
            if placed_units < expected_units:
                shortage += expected_units - placed_units
        return shortage

    if attempts:
        attempts.sort(key=lambda response: (_response_total_shortage_units(response), _schedule_quality(response.schedule)))
        return attempts[0]

    if failures:
        def _week_item_counts(response: ScheduleResponse) -> Tuple[int, int]:
            items = response.schedule or []
            a_count = sum(1 for item in items if (item.week_type or "base") == "A")
            b_count = sum(1 for item in items if (item.week_type or "base") == "B")
            return a_count, b_count

        def _failure_rank(response: ScheduleResponse) -> Tuple[int, int, int, int]:
            items = response.schedule or []
            a_count = sum(1 for item in items if (item.week_type or "base") == "A")
            b_count = sum(1 for item in items if (item.week_type or "base") == "B")
            both_weeks_present = 1 if (a_count > 0 and b_count > 0) else 0
            week_balance = -abs(a_count - b_count)
            shortage_units = _response_total_shortage_units(response)
            subject_day_violations, teacher_day_violations = _hard_post_rule_violation_counts(items)
            hard_violation_total = subject_day_violations + teacher_day_violations
            quality = _schedule_quality(items) if items else 10**9
            return (
                both_weeks_present,
                -shortage_units,
                -hard_violation_total,
                -teacher_day_violations,
                -subject_day_violations,
                -quality,
                len(items),
                week_balance,
                b_count,
            )

        failures_with_both_weeks = [
            response
            for response in failures
            if any((item.week_type or "base") == "A" for item in (response.schedule or []))
            and any((item.week_type or "base") == "B" for item in (response.schedule or []))
        ]

        if failures_with_both_weeks:
            best_failure = max(failures_with_both_weeks, key=_failure_rank)
            best_failure_schedule = _mirror_reduced_tail_for_partial_weeks(
                data,
                list(best_failure.schedule or []),
                timeslot_units_map,
            )
            best_failure_schedule = _fill_reduced_tail_shortage_for_partial_weeks(
                data,
                best_failure_schedule,
                timeslot_units_map,
            )
            best_failure_schedule = _rebalance_1tmt_naturfag_samf_partial(
                data,
                best_failure_schedule,
            )
            merged_metadata = dict(best_failure.metadata or {})
            merged_metadata["partial"] = 1.0
            merged_metadata["placed_count"] = float(len(best_failure_schedule))
            return _success_response_with_hard_rules(ScheduleResponse(
                status="success",
                message=best_failure.message,
                schedule=best_failure_schedule,
                metadata=merged_metadata,
            ))

        failures_with_any_schedule = [response for response in failures if response.schedule]
        if failures_with_any_schedule:
            best_partial = max(failures_with_any_schedule, key=_failure_rank)
            best_partial_schedule = _mirror_reduced_tail_for_partial_weeks(
                data,
                list(best_partial.schedule or []),
                timeslot_units_map,
            )
            best_partial_schedule = _fill_reduced_tail_shortage_for_partial_weeks(
                data,
                best_partial_schedule,
                timeslot_units_map,
            )
            best_partial_schedule = _rebalance_1tmt_naturfag_samf_partial(
                data,
                best_partial_schedule,
            )
            merged_metadata = dict(best_partial.metadata or {})
            merged_metadata["partial"] = 1.0
            merged_metadata["placed_count"] = float(len(best_partial_schedule))
            has_week_a = any((item.week_type or "base") == "A" for item in best_partial_schedule)
            has_week_b = any((item.week_type or "base") == "B" for item in best_partial_schedule)
            merged_metadata["failed_week_a"] = 0.0 if has_week_a else 1.0
            merged_metadata["failed_week_b"] = 0.0 if has_week_b else 1.0
            return _success_response_with_hard_rules(ScheduleResponse(
                status="success",
                message=(
                    "Schedule generated with current constraints. "
                    "Alternating-week mode could not fully place both weeks."
                ),
                schedule=best_partial_schedule,
                metadata=merged_metadata,
            ))

        best_failure = max(failures, key=_failure_rank)
        metadata = dict(best_failure.metadata or {})
        metadata["failed_week_a"] = 1.0
        metadata["failed_week_b"] = 1.0
        return ScheduleResponse(
            status="infeasible",
            message=(
                best_failure.message
                + " Alternating-week mode could not place both A and B weeks with current constraints."
            ),
            schedule=[],
            metadata=metadata,
        )

    return ScheduleResponse(
        status="infeasible",
        message="No valid alternating-week schedule could be generated.",
        schedule=[],
    )

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

    active_timeslots = list(data.timeslots)
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
        if subject.subject_type != "fellesfag":
            continue
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
            teacher_ids=list(subject.teacher_ids or []),
            class_ids=list(subject.class_ids),
            subject_type=subject.subject_type,
            sessions_per_week=subject.sessions_per_week,
            force_place=subject.force_place,
            force_timeslot_id=subject.force_timeslot_id,
            allowed_timeslots=subject.allowed_timeslots,
            allowed_block_ids=merged_block_ids if merged_block_ids else None,
            preferred_room_ids=list(subject.preferred_room_ids or []),
            room_requirement_mode=(subject.room_requirement_mode or "always"),
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
        # For block-linked subjects, never use sessions_per_week as a target.
        # They are governed by explicit block slot/week constraints.
        if subject.id in block_subject_ids:
            required_units = max(0, block_min_units)
        else:
            required_units = max(requested_units, block_min_units)
        subject_sessions_required[subject.id] = required_units

        allowed = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots, timeslots_by_id)
        forced_ts_id = (getattr(subject, "force_timeslot_id", "") or "").strip()
        if getattr(subject, "force_place", False) and forced_ts_id:
            if forced_ts_id not in all_timeslot_ids:
                return ScheduleResponse(
                    status="infeasible",
                    message=(
                        f"Forced slot '{forced_ts_id}' for subject '{subject.name}' ({subject.id}) "
                        "does not exist in active timeslots."
                    ),
                    schedule=[],
                )
            # Force placement must not be filtered out by allowed_timeslots.
            allowed.add(forced_ts_id)

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

            # alternating_week_split parsing and handling DISABLED - feature removed

            unit_gcd = 0
            for t_id in allowed_slot_ids:
                if (subject.id, t_id, "A") in x or (subject.id, t_id, "B") in x:
                    u = max(1, timeslot_units_by_id.get(t_id, 1))
                    unit_gcd = u if unit_gcd == 0 else gcd(unit_gcd, u)
            unit_gcd = max(1, unit_gcd)

            # Fellesfag should not alternate unnecessarily across A/B weeks.
            # Mirror slot decisions and keep equal weekly load unless a block
            # explicitly restricts the subject to one week (handled above).
            if subject.subject_type == "fellesfag" and (required_units % 2 == 0):
                for t_id in allowed_slot_ids:
                    key_a = (subject.id, t_id, "A")
                    key_b = (subject.id, t_id, "B")
                    if key_a in x and key_b in x:
                        model.Add(x[key_a] == x[key_b])

                if required_units % unit_gcd == 0:
                    target_week_units = required_units
                else:
                    lower_target = (required_units // unit_gcd) * unit_gcd
                    upper_target = ((required_units + unit_gcd - 1) // unit_gcd) * unit_gcd

                    feasible_week_targets: List[int] = []
                    for candidate in (lower_target, upper_target):
                        if candidate not in feasible_week_targets and candidate <= max_units_a and candidate <= max_units_b:
                            feasible_week_targets.append(candidate)

                    if not feasible_week_targets:
                        return ScheduleResponse(
                            status="infeasible",
                            message=(
                                f"No representable mirrored weekly load for fellesfag '{subject.name}' ({subject.id}). "
                                f"Required {required_units}x45 but slot granularity is {unit_gcd}x45."
                            ),
                            schedule=[],
                        )

                    target_week_units = min(feasible_week_targets, key=lambda v: abs(v - required_units))

                model.Add(units_sum_a == target_week_units)
                model.Add(units_sum_b == target_week_units)
                continue

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

    # Constraint 2a: a teacher can have at most 3 sessions in one day.
    # Count all subject sessions, including block sessions.
    for teacher in data.teachers:
        teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
        if not teacher_subjects:
            continue
        for week_label in week_labels:
            for day, slot_ids_for_day in day_slot_ids.items():
                daily_session_literals: List[cp_model.IntVar] = [
                    x[(subject.id, timeslot_id, week_label)]
                    for subject in teacher_subjects
                    for timeslot_id in slot_ids_for_day
                    if (subject.id, timeslot_id, week_label) in x
                ]
                if daily_session_literals:
                    model.Add(sum(daily_session_literals) <= 3)

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

        # Hard-lock force-placed subjects to their forced slot in every eligible week.
        for subject in data.subjects:
            if not getattr(subject, "force_place", False):
                continue
            forced_ts_id = (getattr(subject, "force_timeslot_id", "") or "").strip()
            if not forced_ts_id:
                continue

            allowed_weeks_set = set(subject_allowed_weeks.get(subject.id, []))
            for week_label in week_labels:
                if week_label not in allowed_weeks_set:
                    continue
                key = (subject.id, forced_ts_id, week_label)
                if key not in x:
                    return ScheduleResponse(
                        status="infeasible",
                        message=(
                            f"Forced placement for subject '{subject.name}' ({subject.id}) "
                            f"at slot {forced_ts_id} is not feasible in week {week_label}."
                        ),
                        schedule=[],
                    )
                _force_key(key, 1, "subject force_place")

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
    boundary_repeat_excess_terms: List[cp_model.IntVar] = []

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
    first_slot_ids: Set[str] = set()
    last_slot_ids: Set[str] = set()
    for day in days:
        day_slots = [t for t in data.timeslots if t.day == day]
        if not day_slots:
            continue
        sorted_day_slots = sorted(day_slots, key=lambda t: t.period)
        first_slot_ids.add(sorted_day_slots[0].id)
        last_slot_ids.add(sorted_day_slots[-1].id)

    boundary_slot_ids = first_slot_ids | last_slot_ids

    if boundary_slot_ids:
        for subject in data.subjects:
            for timeslot_id in boundary_slot_ids:
                for week_label in week_labels:
                    key = (subject.id, timeslot_id, week_label)
                    if key in x:
                        boundary_slot_penalty_vars.append(x[key])

        # Low-priority preference: avoid repeatedly placing a subject in the first
        # or last period. Allow at most one per side without extra penalty.
        for subject in data.subjects:
            if subject.id in block_subject_ids:
                continue
            for week_label in week_labels:
                first_literals = [
                    x[(subject.id, timeslot_id, week_label)]
                    for timeslot_id in first_slot_ids
                    if (subject.id, timeslot_id, week_label) in x
                ]
                if first_literals:
                    max_first_count = len(first_literals)
                    first_count = model.NewIntVar(
                        0,
                        max_first_count,
                        f"first_count_{subject.id}_{week_label}",
                    )
                    model.Add(first_count == sum(first_literals))
                    first_excess = model.NewIntVar(
                        0,
                        max_first_count,
                        f"first_excess_{subject.id}_{week_label}",
                    )
                    model.Add(first_excess >= first_count - 1)
                    boundary_repeat_excess_terms.append(first_excess)

                last_literals = [
                    x[(subject.id, timeslot_id, week_label)]
                    for timeslot_id in last_slot_ids
                    if (subject.id, timeslot_id, week_label) in x
                ]
                if last_literals:
                    max_last_count = len(last_literals)
                    last_count = model.NewIntVar(
                        0,
                        max_last_count,
                        f"last_count_{subject.id}_{week_label}",
                    )
                    model.Add(last_count == sum(last_literals))
                    last_excess = model.NewIntVar(
                        0,
                        max_last_count,
                        f"last_excess_{subject.id}_{week_label}",
                    )
                    model.Add(last_excess >= last_count - 1)
                    boundary_repeat_excess_terms.append(last_excess)

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
    if boundary_repeat_excess_terms:
        objective_parts.append(BOUNDARY_REPEAT_EXCESS_WEIGHT * sum(boundary_repeat_excess_terms))
    if teacher_presence_excess_terms:
        objective_parts.append(TEACHER_PRESENCE_EXCESS_WEIGHT * sum(teacher_presence_excess_terms))
    if teacher_workload_excess_terms:
        objective_parts.append(TEACHER_WORKLOAD_EXCESS_WEIGHT * sum(teacher_workload_excess_terms))

    # Subject day-distribution rules:
    # - For all subjects except Norsk vg3, allow at most one lesson per day.
    # - For Norsk vg3, prefer at least one double lesson in periods 1+2 or 3+4 each week.
    norsk_vg3_no_double90_terms: List[cp_model.IntVar] = []

    for subject in data.subjects:
        is_norsk_vg3 = _is_norsk_vg3_subject(subject)

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
                        if (ts_a.period, ts_b.period) not in {(1, 2), (3, 4)}:
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

            # Non-Norsk vg3 subjects: enforce at most one lesson on the same day.
            for day, slot_ids in day_slot_ids.items():
                day_literals = [
                    x[(subject.id, ts_id, week_label)]
                    for ts_id in slot_ids
                    if (subject.id, ts_id, week_label) in x
                    if (subject.id, ts_id, week_label) not in forced_zero_keys
                ]
                if len(day_literals) <= 1:
                    continue
                model.Add(sum(day_literals) <= 1)
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
    
    # Debug: log the week split extraction
    _solver_log(f"[DEBUG] Extracting solution: alternating_weeks_enabled={data.alternating_weeks_enabled}")
    for subject in data.subjects:
        subject_line = (
            f"[DEBUG] subject={subject.id} name={subject.name!r} allowed_weeks={subject_allowed_weeks.get(subject.id)} "
            f"total_units_across_weeks={subject_total_units_across_weeks.get(subject.id)}"
        )
        _solver_log(subject_line)
    
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

    _solver_log(f"[DEBUG] Total schedule items created: {len(schedule_items)}")
    week_type_counts = {}
    for item in schedule_items:
        wt = item.week_type or "None"
        week_type_counts[wt] = week_type_counts.get(wt, 0) + 1
    _solver_log(f"[DEBUG] Schedule items by week_type: {week_type_counts}")

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
