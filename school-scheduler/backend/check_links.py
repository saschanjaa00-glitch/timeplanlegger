import json

d = json.load(open('last_generate_request.json', encoding='utf-8'))
linked = [s for s in d['subjects'] if s.get('link_group_id')]
print(f'Linked subjects: {len(linked)}')
for s in linked[:20]:
    print(f"  id={s['id']} name={s['name']} type={s.get('subject_type')} class_ids={s.get('class_ids')} link={s['link_group_id']}")
