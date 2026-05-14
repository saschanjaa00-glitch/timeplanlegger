"""Debug - check leader's allowed_timeslots and allowed_block_ids"""
import json, sys
sys.path.insert(0, '.')
from app.models import ScheduleRequest

data = json.load(open('last_generate_request.json', encoding='utf-8'))
req = ScheduleRequest(**data)

leader_id = 'subject_aktivitetsl_re_vg1_1ida'
follower_id = 'subject_aktivitetsl_re_vg1_1idb'

for sid in [leader_id, follower_id]:
    s = next(x for x in req.subjects if x.id == sid)
    print(f"\n{s.id}:")
    print(f"  allowed_timeslots: {s.allowed_timeslots}")
    print(f"  allowed_block_ids: {s.allowed_block_ids}")
    print(f"  force_place: {s.force_place}")
    print(f"  sessions_per_week: {s.sessions_per_week}")
