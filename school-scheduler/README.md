# School Scheduler (Next.js + FastAPI + OR-Tools)

Minimal working school scheduling app with automatic timetable generation using CP-SAT.

## 1) Project Structure

```text
school-scheduler/
  backend/
    app/
      __init__.py
      main.py
      models.py
      solver.py
    requirements.txt
  frontend/
    app/
      globals.css
      layout.tsx
      page.tsx
    .eslintrc.json
    next-env.d.ts
    next.config.ts
    package.json
    tsconfig.json
  examples.request.json
  .gitignore
  README.md
```

## 2) Backend (FastAPI + OR-Tools)

- Health endpoint: `GET /health`
- Scheduler endpoint: `POST /generate-schedule`
- In-memory request payload only (no database)

Core constraints implemented in `backend/app/solver.py`:

1. Each subject exactly one timeslot
2. Teacher cannot teach >1 subject in same timeslot
3. Class cannot have >1 subject in same timeslot
4. Teacher unavailable timeslots respected
5. Subject allowed timeslots respected
6. Multi-class subjects block all included classes at once

Optional optimization:

- Day load balancing (soft objective)

## 3) Frontend (Next.js + TypeScript)

- Forms to add teachers, classes, timeslots, blocks, subjects
- Generate button calls backend via `fetch()`
- Timetable grid: rows=timeslots, columns=classes

## 4) Example Request/Response

Example request file: `examples.request.json`

Example response (success):

```json
{
  "status": "success",
  "message": "Schedule generated successfully.",
  "schedule": [
    {
      "subject_id": "sub_math_8a",
      "subject_name": "Mathematics",
      "teacher_id": "t_alice",
      "class_ids": ["c_8a"],
      "timeslot_id": "tue_p1",
      "day": "Tuesday",
      "period": 1
    }
  ],
  "metadata": {
    "objective_value": 0.0,
    "wall_time_seconds": 0.02
  }
}
```

## 5) Run Instructions

### Backend

```bash
cd backend
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000.

## 6) Minimal Working Flow

1. Start backend and frontend
2. Add teachers/classes/timeslots/subjects (and optional blocks)
3. Click Generate Schedule
4. Inspect output in the timetable grid

## 7) Improvements (Next Iteration)

- Persist data in PostgreSQL
- Add edit/delete UI controls
- Add stronger optimization (gap minimization, preferred periods)
- Add validation for duplicate IDs and broken references
- Export timetable as CSV/PDF
