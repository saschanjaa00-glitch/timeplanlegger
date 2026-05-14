import json
import sys
sys.path.insert(0, '.')
from app.models import ScheduleRequest
from app.solver import _compute_allowed_timeslots, _subject_link_group_id, _timeslots_overlapping_occurrence, generate_schedule

data = json.load(open('last_generate_request.json', encoding='utf-8'))
req = ScheduleRequest(**data)

# Check if linked subjects are in any blocks
block_subject_ids = set()
for block in req.blocks:
    for entry in block.subject_entries:
        block_subject_ids.add(entry.subject_id)
    for sid in block.subject_ids:
        block_subject_ids.add(sid)


# Find all link groups dynamically
all_linked = [s for s in req.subjects if getattr(s, 'link_group_id', None)]
groups = {}
for s in all_linked:
    groups.setdefault(s.link_group_id, []).append(s)

print(f'Total link groups: {len(groups)}\n')

# Run solver
resp = generate_schedule(req)
print('Status:', resp.status)

items_by_subject = {}
for item in resp.schedule:
    items_by_subject.setdefault(item.subject_id, []).append((item.timeslot_id, item.week_type))

for gid, members in groups.items():
    print(f'\nGroup {gid}:')
    slots_per_member = []
    for s in members:
        slots = sorted(items_by_subject.get(s.id, []))
        slots_per_member.append(set(slots))
        print(f'  {s.id}: {slots}')
    if all(slots_per_member[0] == s for s in slots_per_member):
        print('  --> SYNCED OK')
    else:
        print('  --> MISMATCH (link not enforced!)')
