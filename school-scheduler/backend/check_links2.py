import json
data = json.load(open('last_generate_request.json', encoding='utf-8'))
print('alternating_weeks_enabled:', data.get('alternating_weeks_enabled'))
print('solver_engine:', data.get('solver_engine'))
linked = [s for s in data['subjects'] if s.get('link_group_id') == 'link_aktivitetsl_re_vg1_mo0incj6']
for s in linked:
    print(f"  {s['id']} sessions_per_week={s.get('sessions_per_week')}")
