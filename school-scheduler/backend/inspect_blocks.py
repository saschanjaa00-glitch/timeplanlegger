import json

data = json.load(open('last_generate_request.json', 'r', encoding='utf-8'))
blocks = data.get('blocks', [])
subjects = data.get('subjects', [])
timeslots = data.get('timeslots', [])

print(f'Blocks: {len(blocks)}')
for b in blocks[:15]:
    print(f'  Block {b["id"]}: name={b.get("name")}, class_ids={b.get("class_ids")}, '
          f'subject_entries={len(b.get("subject_entries", []))}, subject_ids={b.get("subject_ids", [])}, '
          f'occs={len(b.get("occurrences", []))}')
    for occ in b.get('occurrences', [])[:3]:
        print(f'    occ: {occ}')

print()
print('Forced subjects:')
for s in subjects:
    if s.get('force_timeslot_id') or s.get('force_place'):
        print(f'  Subject {s["id"]}: name={s.get("name")}, force_timeslot_id={s.get("force_timeslot_id")}, '
              f'force_place={s.get("force_place")}, class_ids={s.get("class_ids")}, '
              f'allowed_block_ids={s.get("allowed_block_ids")}')

print()
print('Timeslots with TID range (08:00-09:50ish):')
for ts in timeslots:
    st = ts.get('start_time', '')
    if st and st < '10:00':
        print(f'  TS {ts["id"]}: day={ts.get("day")}, start={ts.get("start_time")}, end={ts.get("end_time")}')
