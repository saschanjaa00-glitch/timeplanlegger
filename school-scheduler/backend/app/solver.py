from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .models import Block, ScheduleRequest, ScheduleResponse, ScheduledItem, Subject, Timeslot


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
    all_timeslot_ids = set(timeslots_by_id.keys())
    teachers_by_id = {t.id: t for t in data.teachers}

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
    for subject in data.subjects:
        allowed = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots)

        teacher = teachers_by_id.get(subject.teacher_id)
        if teacher:
            allowed -= set(teacher.unavailable_timeslots)

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

    # Constraint 1: every subject must be assigned to exactly one timeslot.
    for subject in data.subjects:
        vars_for_subject = [
            x[(subject.id, t_id, week_label)]
            for t_id in subject_allowed[subject.id]
            for week_label in subject_allowed_weeks[subject.id]
            if (subject.id, t_id, week_label) in x
        ]
        model.Add(sum(vars_for_subject) == 1)

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

    for school_class in data.classes:
        class_subjects = [s for s in data.subjects if school_class.id in s.class_ids]
        total_load = len(class_subjects)
        if not days:
            continue

        min_target = total_load // len(days)
        max_target = (total_load + len(days) - 1) // len(days)

        for day in days:
            day_slot_ids = [t.id for t in data.timeslots if t.day == day]
            day_count = model.NewIntVar(0, total_load, f"count_{school_class.id}_{day}")
            class_day_counts[(school_class.id, day)] = day_count

            vars_for_day = [
                x[(s.id, ts_id, week_label)]
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

    if day_imbalance_terms:
        model.Minimize(sum(day_imbalance_terms))

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
            matched = False
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
                        )
                    )
                    matched = True
                    break
            if matched:
                break

    schedule_items.sort(
        key=lambda item: (
            item.week_type or "",
            item.day,
            item.period,
            item.subject_name,
        )
    )

    return ScheduleResponse(
        status="success",
        message="Schedule generated successfully.",
        schedule=schedule_items,
        metadata={
            "objective_value": float(solver.ObjectiveValue()) if day_imbalance_terms else 0.0,
            "wall_time_seconds": solver.WallTime(),
        },
    )
