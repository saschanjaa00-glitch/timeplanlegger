import json

data = json.load(open('last_generate_request.json', 'r', encoding='utf-8'))
blocks = data.get('blocks', [])
subjects = data.get('subjects', [])
timeslots = data.get('timeslots', [])

subject_names = {s['id']: s.get('name', s['id']) for s in subjects}
ts_by_id = {ts['id']: ts for ts in timeslots}

# Focus on classes from the screenshot context: 1STA, 1TID, 1TMT
focus_classes = ['class_1sta', 'class_1tmt', 'class_1tid']

print('=== Subjects for 1TID and 1TMT ===')
for s in subjects:
    if any(c in s.get('class_ids', []) for c in ['class_1tmt', 'class_1tid']):
        print(f'  {s["id"]}: name={s.get("name")}, class_ids={s.get("class_ids")}, '
              f'force_timeslot_id={s.get("force_timeslot_id")}, force_place={s.get("force_place")}, '
              f'allowed_block_ids={s.get("allowed_block_ids")}')

print()
print('=== subject_toppidrett details ===')
for s in subjects:
    if s['id'] == 'subject_toppidrett':
        print(f'  {s}')

print()
print('=== Blocks that include class_1sta AND have occurrences overlapping 08:00-10:30 ===')
def overlaps(s1, e1, s2, e2):
    def tomin(t):
        h, m = t.split(':')
        return int(h)*60 + int(m)
    return tomin(s1) < tomin(e2) and tomin(s2) < tomin(e1)

for b in blocks:
    if 'class_1sta' not in (b.get('class_ids') or []):
        continue
    for occ in b.get('occurrences', []):
        if overlaps(occ.get('start_time', '00:00'), occ.get('end_time', '00:00'), '08:00', '10:30'):
            print(f'  Block {b["id"]} ({b.get("name")}): occ {occ}')
            break

print()
print('=== Timeslot Wed-2 details (forced Kroppsøving) ===')
ts = ts_by_id.get('Wed-2')
print(f'  {ts}')

print()
print('=== All blocks that have class_1sta and overlap Wed-2 (10:00-11:30) ===')
for b in blocks:
    if 'class_1sta' not in (b.get('class_ids') or []):
        continue
    for occ in b.get('occurrences', []):
        occ_day = occ.get('day', '')
        if occ_day == 'Wednesday' and overlaps(occ.get('start_time', '00:00'), occ.get('end_time', '00:00'), '10:00', '11:30'):
            print(f'  Block {b["id"]} ({b.get("name")}): occ {occ}')

print()
print('=== Generated schedule items for class_1sta, timeslots Wed-1 and Wed-2 ===')
# Load schedule result if available from last run
import os
# Check if there's a saved result
try:
    from app.models import ScheduleRequest
    from app.solver import generate_schedule
    req = ScheduleRequest.model_validate(data)
    res = generate_schedule(req)
    print(f'Schedule generated: {len(res.schedule or [])} items')
    wed_items = [item for item in (res.schedule or []) 
                 if item.day == 'Wednesday' and 'class_1sta' in item.class_ids]
    print(f'Wednesday items for class_1sta: {len(wed_items)}')
    for item in wed_items:
        print(f'  {item.subject_id} ({item.subject_name}): ts={item.timeslot_id}, '
              f'start={item.start_time}, end={item.end_time}, week={item.week_type}')
except Exception as e:
    print(f'Could not generate schedule: {e}')
