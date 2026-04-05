from __future__ import annotations

import json
from pathlib import Path

from app.models import ScheduleRequest
from app.solver import generate_schedule


def _is_a_or_both(week_type: str | None) -> bool:
    return (week_type or "both").strip().lower() in {"a", "both"}


def main() -> None:
    request_path = Path(__file__).parent / "last_generate_request.json"
    request_data = json.loads(request_path.read_text(encoding="utf-8"))
    request = ScheduleRequest.model_validate(request_data)

    # Math subjects linked to a Thursday A/both block occurrence are expected to
    # still have at least one A-week Thursday item in the final returned schedule.
    expected_subject_ids: set[str] = set()
    math_subject_ids = {s.id for s in request.subjects if "matematikk" in s.id.lower()}

    for block in request.blocks:
        block_subject_ids = {entry.subject_id for entry in block.subject_entries}
        block_subject_ids |= set(block.subject_ids)
        relevant_math_subjects = block_subject_ids & math_subject_ids
        if not relevant_math_subjects:
            continue

        has_a_thursday_occurrence = any(
            (occ.day or "").strip().lower() == "thursday" and _is_a_or_both(occ.week_type)
            for occ in (block.occurrences or [])
        )
        if has_a_thursday_occurrence:
            expected_subject_ids |= relevant_math_subjects

    result = generate_schedule(request)
    schedule = list(result.schedule or [])

    actual_subject_ids = {
        item.subject_id
        for item in schedule
        if (item.week_type or "base") == "A"
        and (item.day or "").strip().lower() == "thursday"
        and item.subject_id in expected_subject_ids
    }

    missing = sorted(expected_subject_ids - actual_subject_ids)

    assert expected_subject_ids, "No expected A-week Thursday math block subjects found in request."
    assert not missing, (
        "A-week Thursday block-linked math disappeared in final schedule. "
        f"Missing subjects: {missing}. Solver status={result.status}, message={result.message}"
    )

    print("PASS: A-week Thursday block-linked math is preserved in final schedule output.")
    print(f"Checked subjects: {len(expected_subject_ids)} | status={result.status}")


if __name__ == "__main__":
    main()
