import json

data = json.load(open('last_generate_request.json', 'r', encoding='utf-8'))
from app.models import ScheduleRequest
from app.solver import generate_schedule

req = ScheduleRequest.model_validate(data)
res = generate_schedule(req)

print(f'Schedule generated: {len(res.schedule or [])} items')

# Find toppidrett items
toppidrett_items = [item for item in (res.schedule or []) 
                    if item.subject_id == 'subject_toppidrett']
print(f'\nToppidrett items ({len(toppidrett_items)}):')
for item in toppidrett_items:
    print(f'  day={item.day}, ts={item.timeslot_id}, class_ids={item.class_ids}, '
          f'start={item.start_time}, end={item.end_time}, week={item.week_type}')

# Find Kroppsøving for 1STA
print('\nKroppsøving vg1 1STA items:')
for item in (res.schedule or []):
    if item.subject_id == 'subject_kropps_ving_vg1_1sta':
        print(f'  day={item.day}, ts={item.timeslot_id}, class_ids={item.class_ids}, '
              f'start={item.start_time}, end={item.end_time}, week={item.week_type}')

# Look at all Wednesday items for class_1sta
print('\nAll Wednesday items with class_1sta:')
for item in (res.schedule or []):
    if item.day == 'Wednesday' and 'class_1sta' in item.class_ids:
        print(f'  subj={item.subject_id}, ts={item.timeslot_id}, class_ids={item.class_ids}, '
              f'start={item.start_time}, end={item.end_time}, week={item.week_type}')
