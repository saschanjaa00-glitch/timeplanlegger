"""Debug script: Traces CP-SAT link constraint building for group 1"""
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
subjects_by_id = {s.id: s for s in req.subjects}

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

# Block occupancy (simplified)
class_block_occupied = set()
teacher_block_occupied = set()
week_labels = ["A", "B"] if req.alternating_weeks_enabled else ["base"]

# Build x dict (simulate CP-SAT variable creation)
x_keys = set()  # just track which keys would exist
for subject in req.subjects:
    if subject.id in block_subject_ids or subject.id in forced_subject_ids:
        continue
    teacher_ids = _subject_teacher_ids(subject)
    allowed_slots = _compute_allowed_timeslots(subject, all_timeslot_ids, block_to_timeslots, timeslots_by_id)
    for teacher_id in teacher_ids:
        if teacher_id in teachers_by_id:
            allowed_slots -= set(teachers_by_id[teacher_id].unavailable_timeslots)
    
    subject_class_ids_set = set(subject.class_ids or [])
    
    # Separate tail and regular slots (simplified: treat all as regular)
    regular_ts_ids = sorted(allowed_slots)
    tail_ts_ids = []
    
    subject_allowed_weeks = _compute_allowed_weeks(subject, req.alternating_weeks_enabled, blocks_by_id, {})
    
    for week_key in week_labels:
        if week_key not in subject_allowed_weeks:
            continue
        slots_for_week = [
            ts_id for ts_id in regular_ts_ids
            if not any((c, ts_id, week_key) in class_block_occupied for c in subject_class_ids_set)
            and not any((t, ts_id, week_key) in teacher_block_occupied for t in teacher_ids)
        ]
        for ts_id in slots_for_week:
            x_keys.add((subject.id, ts_id, week_key))

# Now check link constraint for group 1
group_id = 'link_aktivitetsl_re_vg1_mo0incj6'
leader_id = 'subject_aktivitetsl_re_vg1_1ida'
follower_id = 'subject_aktivitetsl_re_vg1_1idb'

print(f"\n=== Link Group: {group_id} ===")
print(f"Leader: {leader_id}")
print(f"Follower: {follower_id}")
print()

common_slots = set()
leader_only_slots = set()
follower_only_slots = set()

for week_key in week_labels:
    for ts_id in sorted(all_timeslot_ids):
        lk = (leader_id, ts_id, week_key)
        fk = (follower_id, ts_id, week_key)
        leader_in_x = lk in x_keys
        follower_in_x = fk in x_keys
        if leader_in_x and follower_in_x:
            common_slots.add((ts_id, week_key))
        elif leader_in_x:
            leader_only_slots.add((ts_id, week_key))
        elif follower_in_x:
            follower_only_slots.add((ts_id, week_key))

print(f"Common slots (equality constraint): {len(common_slots)}")
for ts_id, wk in sorted(common_slots):
    ts = timeslots_by_id[ts_id]
    print(f"  {wk}: {ts_id} ({ts.day} p{ts.period})")

print(f"\nLeader-only slots (leader forced to 0): {len(leader_only_slots)}")
for ts_id, wk in sorted(leader_only_slots):
    ts = timeslots_by_id[ts_id]
    print(f"  {wk}: {ts_id} ({ts.day} p{ts.period})")

print(f"\nFollower-only slots (follower forced to 0): {len(follower_only_slots)}")
for ts_id, wk in sorted(follower_only_slots):
    ts = timeslots_by_id[ts_id]
    print(f"  {wk}: {ts_id} ({ts.day} p{ts.period})")

# Check if Mon-1 and Tue-4 are in x for the leader
print(f"\nLeader x variable exists for Mon-1 week A: {(leader_id, 'Mon-1', 'A') in x_keys}")
print(f"Leader x variable exists for Tue-4 week A: {(leader_id, 'Tue-4', 'A') in x_keys}")
print(f"Follower x variable exists for Mon-1 week A: {(follower_id, 'Mon-1', 'A') in x_keys}")
print(f"Follower x variable exists for Tue-4 week A: {(follower_id, 'Tue-4', 'A') in x_keys}")
