from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .models import Block, BlockOccurrence, ScheduleRequest, ScheduleResponse, ScheduledItem, Subject, Timeslot


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


def _timeslot_45m_units(timeslot: Timeslot) -> int:
    # Scheduling units are slot-based in this project: one selected timeslot equals one unit.
    # This keeps weekly load behavior intuitive in alternating weeks (e.g. 2 each week + 1 every second week).
    return 1


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
            for occ in block.occurrences:
                wt = (occ.week_type or "both").upper()
                if wt in {"A", "B"}:
                    # In non-alternating mode, A/B distinctions collapse into base week.
                    forced_base_slots |= (_timeslots_overlapping_occurrence(occ, all_timeslots) & all_timeslot_ids)
                else:
                    forced_base_slots |= (_timeslots_overlapping_occurrence(occ, all_timeslots) & all_timeslot_ids)
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


def generate_schedule(data: ScheduleRequest) -> ScheduleResponse:
    model = cp_model.CpModel()

    timeslots_by_id: Dict[str, Timeslot] = {t.id: t for t in data.timeslots}
    timeslot_units_by_id: Dict[str, int] = {
        t.id: _timeslot_45m_units(t) for t in data.timeslots
    }
    all_timeslot_ids = set(timeslots_by_id.keys())
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
        # New format: occurrences with day/time
        for occ in b.occurrences:
            slot_set |= _timeslots_overlapping_occurrence(occ, data.timeslots)
        # Legacy format: explicit timeslot_ids
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

    # Augment block subjects: keep each subject's own class_ids (do not inject block class_ids),
    # apply teacher override from subject_entry, and set allowed_block_ids so they are restricted
    # to block timeslots. This lets block subjects behave as alternatives rather than making each
    # class in the block implicitly take every subject.
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

    # Allow block subjects to run in parallel for classes inside their block windows.
    # key = (class_id, subject_id, timeslot_id, week_label)
    block_parallel_allowed_keys: Set[Tuple[str, str, str, str]] = set()
    for block in data.blocks:
        block_timeslot_ids = block_to_timeslots.get(block.id, set())
        if not block_timeslot_ids:
            continue

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

        legacy_active_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
        for ts_id in block.timeslot_ids:
            occ_week_by_slot[ts_id] |= legacy_active_weeks

        block_subject_set = {se.subject_id for se in block.subject_entries} | set(block.subject_ids)
        for class_id in block.class_ids:
            for subject in data.subjects:
                if class_id not in subject.class_ids or subject.id not in block_subject_set:
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

            if required_units % 2 == 0:
                # Even load: identical A/B placement.
                for timeslot_id in allowed_slot_ids:
                    key_a = (subject.id, timeslot_id, "A")
                    key_b = (subject.id, timeslot_id, "B")
                    if key_a in x and key_b in x:
                        model.Add(x[key_a] == x[key_b])
                model.Add(units_sum_a == required_units)
                model.Add(units_sum_b == required_units)
            else:
                # Odd load: heavy week has n, light week has n-1 (45-min units).
                # Light-week slots are constrained to be a subset of heavy-week slots.
                heavy_week_is_a = model.NewBoolVar(f"heavy_week_A_{subject.id}")
                for timeslot_id in allowed_slot_ids:
                    key_a = (subject.id, timeslot_id, "A")
                    key_b = (subject.id, timeslot_id, "B")
                    if key_a not in x or key_b not in x:
                        continue
                    model.Add(x[key_b] <= x[key_a]).OnlyEnforceIf(heavy_week_is_a)
                    model.Add(x[key_a] <= x[key_b]).OnlyEnforceIf(heavy_week_is_a.Not())

                model.Add(units_sum_a == required_units).OnlyEnforceIf(heavy_week_is_a)
                model.Add(units_sum_a == required_units - 1).OnlyEnforceIf(heavy_week_is_a.Not())
                model.Add(units_sum_b == required_units - 1).OnlyEnforceIf(heavy_week_is_a)
                model.Add(units_sum_b == required_units).OnlyEnforceIf(heavy_week_is_a.Not())
        else:
            vars_for_subject = [
                x[(subject.id, t_id, week_label)]
                for t_id in allowed_slot_ids
                for week_label in subject_allowed_weeks[subject.id]
                if (subject.id, t_id, week_label) in x
            ]
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
            model.Add(
                sum(
                    timeslot_units_by_id.get(t_id, 1) * x[(subject.id, t_id, week_label)]
                    for t_id in allowed_slot_ids
                    for week_label in subject_allowed_weeks[subject.id]
                    if (subject.id, t_id, week_label) in x
                )
                == required_units
            )

    # Constraint 2: a teacher cannot teach multiple subjects in the same timeslot.
    for teacher in data.teachers:
        teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
        for week_label in week_labels:
            for timeslot_id in all_timeslot_ids:
                vars_same_slot = [
                    x[(s.id, timeslot_id, week_label)]
                    for s in teacher_subjects
                    if (s.id, timeslot_id, week_label) in x
                ]
                if vars_same_slot:
                    model.Add(sum(vars_same_slot) <= 1)

    # Constraint 3 + 6: each class has at most one subject in each timeslot.
    # Multi-class subjects naturally block all involved classes at that timeslot.
    for school_class in data.classes:
        class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
        for week_label in week_labels:
            for timeslot_id in all_timeslot_ids:
                vars_same_slot = [
                    x[(s.id, timeslot_id, week_label)]
                    for s in class_subjects
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
        legacy_active_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
        for ts_id in block.timeslot_ids:
            occ_week_by_slot[ts_id] |= legacy_active_weeks

        # Subject IDs that belong to this block (new + legacy)
        block_subject_set = {se.subject_id for se in block.subject_entries} | set(block.subject_ids)

        for class_id in block.class_ids:
            class_subjects = [s for s in data.subjects if class_id in s.class_ids]
            block_class_subjects = [s for s in class_subjects if s.id in block_subject_set]
            disallowed_subjects = [s for s in class_subjects if s.id not in block_subject_set]

            # Respect occurrence week_type per slot for block subjects.
            # Example: if Tuesday slot is A-only, block subjects cannot be scheduled there in B.
            for subject in block_class_subjects:
                for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                    if timeslot_id not in all_timeslot_ids:
                        continue
                    for week_label in week_labels:
                        if week_label in blocked_weeks:
                            continue
                        key = (subject.id, timeslot_id, week_label)
                        if key in x:
                            model.Add(x[key] == 0)

            for subject in disallowed_subjects:
                for timeslot_id, blocked_weeks in occ_week_by_slot.items():
                    if timeslot_id not in all_timeslot_ids:
                        continue
                    for week_label in blocked_weeks:
                        key = (subject.id, timeslot_id, week_label)
                        if key in x:
                            model.Add(x[key] == 0)

    # Optional optimization: spread subjects for each class across days.
    days = sorted({t.day for t in data.timeslots})
    class_day_counts: Dict[Tuple[str, str], cp_model.IntVar] = {}
    day_imbalance_terms: List[cp_model.IntVar] = []
    preferred_avoid_penalty_vars: List[cp_model.IntVar] = []
    boundary_slot_penalty_vars: List[cp_model.IntVar] = []

    for school_class in data.classes:
        class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
        total_load = sum(subject_total_units_across_weeks.get(s.id, 0) for s in class_subjects)
        if not days:
            continue

        min_target = total_load // len(days)
        max_target = (total_load + len(days) - 1) // len(days)

        for day in days:
            day_slot_ids = [t.id for t in data.timeslots if t.day == day]
            day_count = model.NewIntVar(0, total_load, f"count_{school_class.id}_{day}")
            class_day_counts[(school_class.id, day)] = day_count

            vars_for_day = [
                timeslot_units_by_id.get(ts_id, 1) * x[(s.id, ts_id, week_label)]
                for s in class_subjects
                for ts_id in day_slot_ids
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
        objective_parts.append(sum(day_imbalance_terms))
    if preferred_avoid_penalty_vars:
        # Keep this as a soft penalty: reduce preferred-avoid assignments where feasible.
        objective_parts.append(sum(preferred_avoid_penalty_vars))
    if boundary_slot_penalty_vars:
        objective_parts.append(sum(boundary_slot_penalty_vars))

    if objective_parts:
        model.Minimize(sum(objective_parts))

    def _lower_bound_units_for_week(subject: Subject, week_label: str) -> int:
        required_units = subject_sessions_required[subject.id]
        allowed_weeks = set(subject_allowed_weeks[subject.id])
        if week_label not in allowed_weeks:
            return 0
        if data.alternating_weeks_enabled and allowed_weeks == {"A", "B"}:
            if required_units % 2 == 0:
                return required_units
            return max(0, required_units - 1)
        return required_units

    def _build_infeasibility_hints() -> List[str]:
        hints: List[str] = []

        class_issues: List[str] = []
        for school_class in data.classes:
            class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
            for week_label in week_labels:
                demand = 0
                feasible_slot_ids: Set[str] = set()

                for subject in class_subjects:
                    lb = _lower_bound_units_for_week(subject, week_label)
                    if lb <= 0:
                        continue

                    consuming_slot_ids = {
                        ts_id
                        for ts_id in subject_allowed[subject.id]
                        if (subject.id, ts_id, week_label) in x
                        and (school_class.id, subject.id, ts_id, week_label) not in block_parallel_allowed_keys
                    }
                    if not consuming_slot_ids:
                        continue

                    demand += lb
                    feasible_slot_ids |= consuming_slot_ids

                capacity = len(feasible_slot_ids)
                if demand > capacity:
                    class_issues.append(
                        f"class {school_class.name} ({week_label}): demand {demand} > slot capacity {capacity}"
                    )

        if class_issues:
            hints.append("Class bottlenecks: " + "; ".join(class_issues[:5]))

        teacher_issues: List[str] = []
        for teacher in data.teachers:
            teacher_subjects = [s for s in data.subjects if s.teacher_id == teacher.id]
            if not teacher_subjects:
                continue
            for week_label in week_labels:
                demand = sum(_lower_bound_units_for_week(s, week_label) for s in teacher_subjects)
                feasible_slot_ids = {
                    ts_id
                    for s in teacher_subjects
                    for ts_id in subject_allowed[s.id]
                    if (s.id, ts_id, week_label) in x
                }
                capacity = len(feasible_slot_ids)
                if demand > capacity:
                    teacher_issues.append(
                        f"teacher {teacher.name} ({week_label}): demand {demand} > slot capacity {capacity}"
                    )

        if teacher_issues:
            hints.append("Teacher bottlenecks: " + "; ".join(teacher_issues[:5]))

        return hints

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        hints = _build_infeasibility_hints()
        message = "No valid schedule found for the provided constraints."
        if hints:
            message = message + " " + " | ".join(hints)
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
