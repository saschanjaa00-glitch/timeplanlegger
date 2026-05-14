"""Debug - check leader's force_timeslot_ids"""
import json, sys
sys.path.insert(0, '.')
from app.models import ScheduleRequest

data = json.load(open('last_generate_request.json', encoding='utf-8'))
req = ScheduleRequest(**data)

leader_id = 'subject_aktivitetsl_re_vg1_1ida'
s = next(x for x in req.subjects if x.id == leader_id)
print(f"force_timeslot_id: {s.force_timeslot_id}")
print(f"force_timeslot_ids: {s.force_timeslot_ids}")
print(f"force_week_type: {s.force_week_type}")
