import json

data = json.load(open('last_generate_request.json', 'r', encoding='utf-8'))
blocks = data.get('blocks', [])
subjects = data.get('subjects', [])
timeslots = data.get('timeslots', [])

# Build subject name lookup
subject_names = {s['id']: s.get('name', s['id']) for s in subjects}

# Find block_tid_tmt
for b in blocks:
    if b['id'] == 'block_tid_tmt':
        print(f'Block: {b["name"]} ({b["id"]})')
        print(f'  class_ids: {b.get("class_ids")}')
        print(f'  subject_entries:')
        for se in b.get('subject_entries', []):
            sid = se.get('subject_id')
            print(f'    {sid} = {subject_names.get(sid, "?")}')
        print(f'  subject_ids: {b.get("subject_ids")}')
        print(f'  occurrences:')
        for occ in b.get('occurrences', []):
            print(f'    {occ}')

print()
print('Subjects for class_1sta:')
for s in subjects:
    if 'class_1sta' in s.get('class_ids', []):
        print(f'  {s["id"]}: name={s.get("name")}, force_timeslot_id={s.get("force_timeslot_id")}, '
              f'force_place={s.get("force_place")}, allowed_block_ids={s.get("allowed_block_ids")}, '
              f'sessions_per_week={s.get("sessions_per_week")}')

print()
print('All timeslots:')
for ts in timeslots:
    print(f'  {ts["id"]}: day={ts.get("day")}, start={ts.get("start_time")}, end={ts.get("end_time")}')
