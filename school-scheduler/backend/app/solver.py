from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .models import Block, ScheduleRequest, ScheduleResponse, ScheduledItem, Subject, Timeslot


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
    start = _to_minutes(timeslot.start_time)
    end = _to_minutes(timeslot.end_time)
    if start is None or end is None or end <= start:
        return 1
    duration = end - start
    # Convert slot duration to 45-minute session units.
    # Typical 90-minute school slots become 2 units.
    return max(1, int(round(duration / 45.0)))


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
        week_pattern = (block.week_pattern or "both").upper()
        if week_pattern == "A":
            allowed_weeks.add("A")
        elif week_pattern == "B":
            allowed_weeks.add("B")
        else:
            allowed_weeks.update({"A", "B"})

    return allowed_weeks or {"A", "B"}


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

    block_to_timeslots = {b.id: set(b.timeslot_ids) for b in data.blocks}
    blocks_by_id: Dict[str, Block] = {b.id: b for b in data.blocks}

    linked_block_ids: Dict[str, Set[str]] = defaultdict(set)
    for block in data.blocks:
        for subject_id in block.subject_ids:
            linked_block_ids[subject_id].add(block.id)

    week_labels = ["A", "B"] if data.alternating_weeks_enabled else ["base"]

    # Decision variable x[(subject_id, timeslot_id, week_label)] == 1 when subject is placed there.
    x: Dict[Tuple[str, str, str], cp_model.IntVar] = {}

    subject_allowed: Dict[str, List[str]] = {}
    subject_allowed_weeks: Dict[str, List[str]] = {}
    subject_sessions_required: Dict[str, int] = {}
    subject_total_units_across_weeks: Dict[str, int] = {}
    for subject in data.subjects:
        required_units = max(1, int(subject.sessions_per_week or 1))
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
            # In alternating mode with both weeks available, subjects run in both weeks.
            subject_total_units_across_weeks[subject.id] = required_units * 2
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

    # Constraint 1: session load per subject.
    # When alternating weeks are enabled and both weeks are available:
    # - even load n (45-min units): same load in A and B weeks (fully mirrored)
    # - odd load n: one heavy week (n+1) and one light week (n-1),
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
                        f"to place {required_units}x45 in both A and B weeks."
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
                # Odd load: heavy week has n+1, light week has n-1 (45-min units).
                # Light-week slots are constrained to be a subset of heavy-week slots.
                heavy_week_is_a = model.NewBoolVar(f"heavy_week_A_{subject.id}")
                for timeslot_id in allowed_slot_ids:
                    key_a = (subject.id, timeslot_id, "A")
                    key_b = (subject.id, timeslot_id, "B")
                    if key_a not in x or key_b not in x:
                        continue
                    model.Add(x[key_b] <= x[key_a]).OnlyEnforceIf(heavy_week_is_a)
                    model.Add(x[key_a] <= x[key_b]).OnlyEnforceIf(heavy_week_is_a.Not())

                model.Add(units_sum_a == required_units + 1).OnlyEnforceIf(heavy_week_is_a)
                model.Add(units_sum_a == required_units - 1).OnlyEnforceIf(heavy_week_is_a.Not())
                model.Add(units_sum_b == required_units - 1).OnlyEnforceIf(heavy_week_is_a)
                model.Add(units_sum_b == required_units + 1).OnlyEnforceIf(heavy_week_is_a.Not())
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
                    if (s.id, timeslot_id, week_label) in x
                ]
                if vars_same_slot:
                    model.Add(sum(vars_same_slot) <= 1)

    # Constraint 7: block lock.
    # For classes attached to a block, non-block subjects are not allowed in that block's slots/weeks.
    for block in data.blocks:
        active_block_weeks = _block_active_weeks(block, data.alternating_weeks_enabled)
        block_subject_set = set(block.subject_ids)

        for class_id in block.class_ids:
            class_subjects = [s for s in data.subjects if class_id in s.class_ids]
            disallowed_subjects = [
                s
                for s in class_subjects
                if s.id not in block_subject_set and block.id not in (s.allowed_block_ids or [])
            ]

            for subject in disallowed_subjects:
                for timeslot_id in block.timeslot_ids:
                    if timeslot_id not in all_timeslot_ids:
                        continue
                    for week_label in active_block_weeks:
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

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ScheduleResponse(
            status="infeasible",
            message="No valid schedule found for the provided constraints.",
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
