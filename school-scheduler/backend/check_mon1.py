"""Debug - check what occupies Mon-1 for class_1idb"""
import json, sys
sys.path.insert(0, '.')
from app.models import ScheduleRequest
from app.solver import generate_schedule

data = json.load(open('last_generate_request.json', encoding='utf-8'))
req = ScheduleRequest(**data)
resp = generate_schedule(req)

# Find all items at Mon-1 for class_1idb
print("Items at Mon-1 for class_1idb:")
for item in resp.schedule:
    if 'class_1idb' in item.class_ids and item.timeslot_id == 'Mon-1':
        print(f"  {item.subject_id}: week={item.week_type}")

# Also check if Mon-1 is blocked by a block for class_1idb or class_1ida
print("\nBlocks covering Mon-1:")
from app.solver import _timeslots_overlapping_occurrence
ts_by_id = {t.id: t for t in req.timeslots}
all_ts = set(ts_by_id.keys())
for block in req.blocks:
    slots = set()
    for occ in block.occurrences:
        slots |= _timeslots_overlapping_occurrence(occ, list(req.timeslots)) & all_ts
    if 'Mon-1' in slots:
        print(f"  Block {block.id}: class_ids={block.class_ids}")
