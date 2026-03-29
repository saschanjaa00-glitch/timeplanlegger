from app.models import *
from app.solver import *

# Simulate the user's setup
data = ScheduleRequest(
    subjects=[
        Subject(
            id="kjemi1", name="Kjemi 1", teacher_id="t1", class_ids=["2stb"],
            subject_type="programfag", sessions_per_week=3  # 3 slots/week in alternating semantics => 2 each week + 1 every second week
        )
    ],
    teachers=[Teacher(id="t1", name="Teacher")],
    classes=[Class(id="2stb", name="2STB")],
    timeslots=[
        Timeslot(id="ts_wed", day="Wednesday", period=1, start_time="08:20", end_time="09:50"),
        Timeslot(id="ts_fri", day="Friday", period=1, start_time="08:20", end_time="09:50"),
        Timeslot(id="ts_tue", day="Tuesday", period=4, start_time="13:40", end_time="15:10"),
    ],
    blocks=[
        Block(
            id="blk1", name="Blokk 1",
            occurrences=[
                BlockOccurrence(id="o1", day="Wednesday", start_time="08:20", end_time="09:50", week_type="both"),
                BlockOccurrence(id="o2", day="Friday", start_time="08:20", end_time="09:50", week_type="both"),
                BlockOccurrence(id="o3", day="Tuesday", start_time="13:40", end_time="15:10", week_type="both"),
            ],
            class_ids=["2stb"],
            subject_entries=[BlockSubjectEntry(subject_id="kjemi1", teacher_id="t1")],
        )
    ],
    meetings=[],
    rooms=[],
    alternating_weeks_enabled=False,
)

print("=== Input Data ===")
print(f"Subject: {data.subjects[0]}")
print(f"  id={data.subjects[0].id}")
print(f"  teacher_id={data.subjects[0].teacher_id}")
print(f"  class_ids={data.subjects[0].class_ids}")
print(f"  sessions_per_week={data.subjects[0].sessions_per_week}")
print(f"  allowed_block_ids={data.subjects[0].allowed_block_ids}")
print()
print("Block: " + data.blocks[0].id)
print(f"  class_ids={data.blocks[0].class_ids}")
print(f"  subject_entries={[(se.subject_id, se.teacher_id) for se in data.blocks[0].subject_entries]}")
print(f"  occurrences={len(data.blocks[0].occurrences)}")
for occ in data.blocks[0].occurrences:
    print(f"    - {occ.day} {occ.start_time}-{occ.end_time} ({occ.week_type})")
print()
print("Timeslots:")
for ts in data.timeslots:
    print(f"  {ts.id}: {ts.day} {ts.start_time}-{ts.end_time}")

result = generate_schedule(data)
print(f"\nStatus: {result.status}")
print(f"Items generated: {len(result.schedule)}")
for item in result.schedule:
    print(f"  {item.subject_name} on {item.day} (ts: {item.timeslot_id})")
