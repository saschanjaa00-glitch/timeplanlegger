"""Debug script: Traces why leader has no x variables in CP-SAT"""
import json
import sys
from collections import defaultdict
sys.path.insert(0, '.')
from app.models import ScheduleRequest
from app.solver import (
    _compute_allowed_timeslots, _subject_link_group_id,
    _timeslots_overlapping_occurrence, _timeslot_45m_units,
    _subject_teacher_ids, _compute_allowed_weeks,
    _get_forced_ts_ids
)

data = json.load(open('last_generate_request.json', encoding='utf-8'))
req = ScheduleRequest(**data)

timeslots_by_id = {t.id: t for t in req.timeslots}
all_timeslot_ids = set(timeslots_by_id.keys())
teachers_by_id = {t.id: t for t in req.teachers}
blocks_by_id = {b.id: b for b in req.blocks}

block_to_timeslots = {}
for block in req.blocks:
    slot_set = set()
    for occ in block.occurrences:
        slot_set |= (_timeslots_overlapping_occurrence(occ, list(req.timeslots)) & all_timeslot_ids)
    if not block.occurrences:
        slot_set |= (set(block.timeslot_ids) & all_timeslot_ids)
    block_to_timeslots[block.id] = slot_set

# Block subject IDs
block_subject_ids = set()
for block in req.blocks:
    for entry in block.subject_entries:
        block_subject_ids.add(entry.subject_id)
    for sid in block.subject_ids:
        block_subject_ids.add(sid)

# Forced subject IDs
forced_subject_ids = set()
for subject in req.subjects:
    forced_ts_ids = _get_forced_ts_ids(subject)
    if getattr(subject, 'force_place', False) and forced_ts_ids:
        forced_subject_ids.add(subject.id)

# Build class_block_occupied properly from blocks
class_block_occupied = set()
teacher_block_occupied = set()
week_labels = ["A", "B"] if req.alternating_weeks_enabled else ["base"]
subjects_by_id = {s.id: s for s in req.subjects}

for meeting in req.meetings:
    if meeting.timeslot_id not in all_timeslot_ids:
        continue
    for assignment in meeting.teacher_assignments:
        if assignment.mode == "unavailable":
            for wk in week_labels:
                teacher_block_occupied.add((assignment.teacher_id, meeting.timeslot_id, wk))

for block in req.blocks:
    all_entries = list(block.subject_entries)
    for occ in block.occurrences:
        occ_week_raw = (occ.week_type or "both").strip().upper()
        if occ_week_raw in ("BOTH", ""):
            occ_week_keys = list(week_labels)
        elif occ_week_raw == "A":
            occ_week_keys = ["A"] if "A" in week_labels else list(week_labels)
        elif occ_week_raw == "B":
            occ_week_keys = ["B"] if "B" in week_labels else list(week_labels)
        else:
            occ_week_keys = list(week_labels)
        
        overlapping_ts_ids = _timeslots_overlapping_occurrence(occ, list(req.timeslots)) & all_timeslot_ids
        for ts_id in overlapping_ts_ids:
            for wk in occ_week_keys:
                for class_id in (block.class_ids or []):
                    class_block_occupied.add((class_id, ts_id, wk))
                for entry in all_entries:
                    s = subjects_by_id.get(entry.subject_id)
                    if s:
                        for tid in _subject_teacher_ids(s):
                            if tid:
                                teacher_block_occupied.add((tid, ts_id, wk))

# Forced class occupancy
forced_class_occupied = set()
for subject in req.subjects:
    forced_ts_list = _get_forced_ts_ids(subject)
    if not (getattr(subject, 'force_place', False) and forced_ts_list):
        continue
    teacher_ids_forced = _subject_teacher_ids(subject)
    for forced_ts_id in forced_ts_list:
        ts_fp = timeslots_by_id.get(forced_ts_id)
        if not ts_fp:
            continue
        for wk in week_labels:
            for class_id in (subject.class_ids or []):
                forced_class_occupied.add((class_id, forced_ts_id, wk))
            for tid in teacher_ids_forced:
                if tid:
                    teacher_block_occupied.add((tid, forced_ts_id, wk))

class_block_occupied |= forced_class_occupied

# Now check leader
leader_id = 'subject_aktivitetsl_re_vg1_1ida'
follower_id = 'subject_aktivitetsl_re_vg1_1idb'
leader = next(s for s in req.subjects if s.id == leader_id)
follower = next(s for s in req.subjects if s.id == follower_id)

print(f"Leader class: {leader.class_ids}")
print(f"Follower class: {follower.class_ids}")

# Check leader's allowed slots
leader_allowed = _compute_allowed_timeslots(leader, all_timeslot_ids, block_to_timeslots, timeslots_by_id)
leader_teacher_ids = _subject_teacher_ids(leader)
for tid in leader_teacher_ids:
    if tid in teachers_by_id:
        leader_allowed -= set(teachers_by_id[tid].unavailable_timeslots)

print(f"\nLeader raw allowed slots: {len(leader_allowed)}")
for ts_id in sorted(leader_allowed):
    ts = timeslots_by_id[ts_id]
    blocked_a = (leader.class_ids[0], ts_id, "A") in class_block_occupied
    blocked_b = (leader.class_ids[0], ts_id, "B") in class_block_occupied
    x_a = not blocked_a
    x_b = not blocked_b
    print(f"  {ts_id} ({ts.day} p{ts.period}): class_blocked_A={blocked_a} class_blocked_B={blocked_b} x_var_A={x_a} x_var_B={x_b}")

# Check what blocks occupy class_1ida timeslots
print(f"\nBlock occupancy for class_1ida:")
class_1ida = leader.class_ids[0]
for (cid, ts_id, wk) in sorted(class_block_occupied):
    if cid == class_1ida and ts_id in leader_allowed:
        ts = timeslots_by_id.get(ts_id)
        print(f"  {wk}: {ts_id} ({ts.day if ts else '?'} p{ts.period if ts else '?'})")
