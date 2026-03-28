"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Subject = {
  id: string;
  name: string;
  teacher_id: string;
  class_ids: string[];
  subject_type: "fellesfag" | "programfag";
  sessions_per_week: number;
  allowed_timeslots?: string[];
  allowed_block_ids?: string[];
};

type Teacher = {
  id: string;
  name: string;
  unavailable_timeslots: string[];
};

type SchoolClass = {
  id: string;
  name: string;
};

type Timeslot = {
  id: string;
  day: string;
  period: number;
  start_time?: string;
  end_time?: string;
  is_double?: boolean;
  is_idrett?: boolean;
  is_lunch?: boolean;
};

type Block = {
  id: string;
  name: string;
  timeslot_ids: string[];
  week_pattern?: "both" | "A" | "B";
  a_week_lessons?: number;
  b_week_lessons?: number;
  class_ids?: string[];
  subject_ids?: string[];
};

type TabKey = "calendar" | "classes" | "subjects" | "blocks" | "teachers" | "generate";

type WeekMode = "A" | "B";

type WeekView = "both" | "A" | "B";

type ResizeState = {
  timeslotId: string;
  edge: "start" | "end";
  containerTop: number;
  containerHeight: number;
};

type WeekCalendarSetup = {
  id: string;
  name: string;
  timeslots: Timeslot[];
  class_ids: string[];
};

type ScheduledItem = {
  subject_id: string;
  subject_name: string;
  teacher_id: string;
  class_ids: string[];
  timeslot_id: string;
  day: string;
  period: number;
  week_type?: "A" | "B";
};

type GenerateResponse = {
  status: string;
  message: string;
  schedule: ScheduledItem[];
  metadata?: Record<string, number>;
};

const API_BASE = "http://localhost:8000";

const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const calendarDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_START_MINUTES = 8 * 60;
const DAY_END_MINUTES = 16 * 60;
const TIMELINE_TOTAL_MINUTES = DAY_END_MINUTES - DAY_START_MINUTES;
const STORAGE_KEY = "school_scheduler_state_v2";

const workflowTabs: Array<{ id: TabKey; label: string }> = [
  { id: "calendar", label: "Week Calendar" },
  { id: "classes", label: "Classes" },
  { id: "subjects", label: "Subjects" },
  { id: "blocks", label: "Blocks" },
  { id: "teachers", label: "Teachers" },
  { id: "generate", label: "Generate" },
];

function parseWeekMode(value: unknown): WeekMode {
  return value === "B" ? "B" : "A";
}

function parseWeekView(value: unknown): WeekView {
  return value === "A" || value === "B" ? value : "both";
}

function normalizeBlock(block: Partial<Block>): Block {
  return {
    id: block.id ?? "",
    name: block.name ?? "",
    timeslot_ids: Array.isArray(block.timeslot_ids) ? block.timeslot_ids : [],
    week_pattern: block.week_pattern === "A" || block.week_pattern === "B" ? block.week_pattern : "both",
    a_week_lessons: typeof block.a_week_lessons === "number" ? block.a_week_lessons : 5,
    b_week_lessons: typeof block.b_week_lessons === "number" ? block.b_week_lessons : 5,
    class_ids: Array.isArray(block.class_ids) ? block.class_ids : [],
    subject_ids: Array.isArray(block.subject_ids) ? block.subject_ids : [],
  };
}

function normalizeSubject(subject: Partial<Subject>): Subject {
  return {
    id: subject.id ?? "",
    name: subject.name ?? "",
    teacher_id: subject.teacher_id ?? "",
    class_ids: Array.isArray(subject.class_ids) ? subject.class_ids : [],
    subject_type: subject.subject_type === "programfag" ? "programfag" : "fellesfag",
    sessions_per_week:
      typeof subject.sessions_per_week === "number" && subject.sessions_per_week > 0
        ? Math.floor(subject.sessions_per_week)
        : 1,
    allowed_timeslots: Array.isArray(subject.allowed_timeslots) ? subject.allowed_timeslots : undefined,
    allowed_block_ids: Array.isArray(subject.allowed_block_ids) ? subject.allowed_block_ids : undefined,
  };
}

function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function makeUniqueId(base: string, existingIds: string[]): string {
  const existing = new Set(existingIds);
  if (!existing.has(base)) {
    return base;
  }

  let i = 2;
  while (existing.has(`${base}_${i}`)) {
    i += 1;
  }
  return `${base}_${i}`;
}

function toMinutes(value?: string): number {
  if (!value || !value.includes(":")) {
    return Number.MAX_SAFE_INTEGER;
  }
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return Number.MAX_SAFE_INTEGER;
  }
  return h * 60 + m;
}

function normalizeTime24(value: string): string {
  const trimmed = value.trim();

  const compactMatch = trimmed.match(/^(\d{4})$/);
  if (compactMatch) {
    const digits = compactMatch[1];
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
  }

  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return trimmed;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return trimmed;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minutesToTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getMidpointTime(start?: string, end?: string): string | null {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  if (startMinutes === Number.MAX_SAFE_INTEGER || endMinutes === Number.MAX_SAFE_INTEGER || endMinutes <= startMinutes) {
    return null;
  }
  const midpoint = Math.round((startMinutes + endMinutes) / 2);
  return minutesToTime(midpoint);
}

function getSlotToneClass(slot?: Timeslot): string {
  if (!slot) {
    return "";
  }
  if (slot.is_lunch) {
    return "lunch";
  }
  if (slot.is_idrett) {
    return "idrett";
  }
  return "";
}

function computeDaySlotLayout(slots: Timeslot[]): Record<string, { col: number; count: number }> {
  const valid = [...slots]
    .map((slot) => ({ slot, start: toMinutes(slot.start_time), end: toMinutes(slot.end_time) }))
    .filter((x) => x.start !== Number.MAX_SAFE_INTEGER && x.end !== Number.MAX_SAFE_INTEGER && x.end > x.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  const result: Record<string, { col: number; count: number }> = {};
  let i = 0;

  while (i < valid.length) {
    let clusterEnd = valid[i].end;
    const cluster: Array<{ slot: Timeslot; start: number; end: number }> = [valid[i]];
    i += 1;

    while (i < valid.length && valid[i].start < clusterEnd) {
      cluster.push(valid[i]);
      clusterEnd = Math.max(clusterEnd, valid[i].end);
      i += 1;
    }

    const columnEnds: number[] = [];
    let maxCols = 0;
    for (const item of cluster) {
      let col = 0;
      while (col < columnEnds.length && columnEnds[col] > item.start) {
        col += 1;
      }
      if (col === columnEnds.length) {
        columnEnds.push(item.end);
      } else {
        columnEnds[col] = item.end;
      }
      maxCols = Math.max(maxCols, columnEnds.length);
      result[item.slot.id] = { col, count: 1 };
    }

    for (const item of cluster) {
      if (result[item.slot.id]) {
        result[item.slot.id].count = maxCols;
      }
    }
  }

  return result;
}

function toDayPrefix(day: string): string {
  const three = day.slice(0, 3);
  if (!three) {
    return "Day";
  }
  return `${three[0].toUpperCase()}${three.slice(1).toLowerCase()}`;
}

function normalizeTimeslotIds(timeslots: Timeslot[]): {
  normalizedTimeslots: Timeslot[];
  idMap: Record<string, string>;
} {
  const grouped = new Map<string, Timeslot[]>();
  for (const slot of timeslots) {
    if (!grouped.has(slot.day)) {
      grouped.set(slot.day, []);
    }
    grouped.get(slot.day)?.push(slot);
  }

  const orderedDays = Array.from(grouped.keys()).sort((a, b) => {
    const ai = dayOrder.indexOf(a);
    const bi = dayOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) {
      return ai - bi;
    }
    if (ai !== -1) {
      return -1;
    }
    if (bi !== -1) {
      return 1;
    }
    return a.localeCompare(b);
  });

  const idMap: Record<string, string> = {};
  const normalizedTimeslots: Timeslot[] = [];

  for (const day of orderedDays) {
    const daySlots = [...(grouped.get(day) ?? [])].sort((a, b) => {
      const startCmp = toMinutes(a.start_time) - toMinutes(b.start_time);
      if (startCmp !== 0) {
        return startCmp;
      }
      const endCmp = toMinutes(a.end_time) - toMinutes(b.end_time);
      if (endCmp !== 0) {
        return endCmp;
      }
      return a.id.localeCompare(b.id);
    });

    daySlots.forEach((slot, index) => {
      const newId = `${toDayPrefix(day)}-${index + 1}`;
      idMap[slot.id] = newId;
      normalizedTimeslots.push({
        ...slot,
        id: newId,
        period: index + 1,
      });
    });
  }

  return { normalizedTimeslots, idMap };
}

function indexToLetters(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

export default function Home() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [timeslots, setTimeslots] = useState<Timeslot[]>([]);
  const [weekCalendarSetups, setWeekCalendarSetups] = useState<WeekCalendarSetup[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [schedule, setSchedule] = useState<ScheduledItem[]>([]);
  const [statusText, setStatusText] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("calendar");
  const [enableAlternatingWeeks, setEnableAlternatingWeeks] = useState(false);
  const [activeWeekMode, setActiveWeekMode] = useState<WeekMode>("A");
  const [weekView, setWeekView] = useState<WeekView>("both");

  const [subjectForm, setSubjectForm] = useState({
    name: "",
  });
  const [teacherForm, setTeacherForm] = useState({ name: "", unavailable_timeslots: "" });
  const [classForm, setClassForm] = useState({ name: "", setupId: "" });
  const [bulkClassForm, setBulkClassForm] = useState({
    years: "3",
    abbreviation: "ST",
    classesPerYear: "6",
    setupId: "",
  });
  const [timeslotForm, setTimeslotForm] = useState({
    day: "Monday",
    start_time: "08:00",
    end_time: "08:45",
    is_double: false,
    is_idrett: false,
    is_lunch: false,
  });
  const [activeCalendarDay, setActiveCalendarDay] = useState("Monday");
  const [editingTimeslotId, setEditingTimeslotId] = useState<string | null>(null);
  const [draggingTimeslotId, setDraggingTimeslotId] = useState<string | null>(null);
  const [isDeleteZoneActive, setIsDeleteZoneActive] = useState(false);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const timeslotsRef = useRef<Timeslot[]>(timeslots);
  const [weekSetupForm, setWeekSetupForm] = useState({
    name: "",
  });
  const [activeWeekSetupId, setActiveWeekSetupId] = useState<string | null>(null);
  const [renamingWeekSetupId, setRenamingWeekSetupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [expandedClassId, setExpandedClassId] = useState<string | null>(null);
  const [expandedSubjectId, setExpandedSubjectId] = useState<string | null>(null);
  const [fellesfagSelectionByClass, setFellesfagSelectionByClass] = useState<Record<string, string>>({});
  const [duplicateTargetsByClass, setDuplicateTargetsByClass] = useState<Record<string, string[]>>({});
  const [blockForm, setBlockForm] = useState({
    name: "",
    timeslot_ids: "",
    week_pattern: "both" as WeekView,
    a_week_lessons: "5",
    b_week_lessons: "5",
    class_ids: [] as string[],
    subject_ids: [] as string[],
  });
  const [isStorageHydrated, setIsStorageHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const legacyRaw = window.localStorage.getItem("school_scheduler_state_v1");
      const source = raw ?? legacyRaw;

      if (!source) {
        setIsStorageHydrated(true);
        return;
      }

      const parsed = JSON.parse(source) as Partial<{
        subjects: Subject[];
        teachers: Teacher[];
        classes: SchoolClass[];
        timeslots: Timeslot[];
        weekCalendarSetups: WeekCalendarSetup[];
        blocks: Block[];
        schedule: ScheduledItem[];
        activeCalendarDay: string;
        activeTab: TabKey;
        activeWeekSetupId: string | null;
        enableAlternatingWeeks: boolean;
        activeWeekMode: WeekMode;
        weekView: WeekView;
      }>;

      if (Array.isArray(parsed.subjects)) {
        setSubjects(parsed.subjects.map((subject) => normalizeSubject(subject)));
      }
      if (Array.isArray(parsed.teachers)) {
        setTeachers(parsed.teachers);
      }
      if (Array.isArray(parsed.classes)) {
        setClasses(parsed.classes);
      }
      if (Array.isArray(parsed.timeslots)) {
        setTimeslots(parsed.timeslots);
      }
      if (Array.isArray(parsed.weekCalendarSetups)) {
        setWeekCalendarSetups(parsed.weekCalendarSetups);
      }
      if (Array.isArray(parsed.blocks)) {
        setBlocks(parsed.blocks.map((block) => normalizeBlock(block)));
      }
      if (Array.isArray(parsed.schedule)) {
        setSchedule(parsed.schedule);
      }
      if (typeof parsed.activeCalendarDay === "string" && calendarDays.includes(parsed.activeCalendarDay)) {
        setActiveCalendarDay(parsed.activeCalendarDay);
      }
      if (parsed.activeTab && workflowTabs.some((tab) => tab.id === parsed.activeTab)) {
        setActiveTab(parsed.activeTab);
      }
      if (typeof parsed.activeWeekSetupId === "string") {
        setActiveWeekSetupId(parsed.activeWeekSetupId);
      }
      if (typeof parsed.enableAlternatingWeeks === "boolean") {
        setEnableAlternatingWeeks(parsed.enableAlternatingWeeks);
      }
      setActiveWeekMode(parseWeekMode(parsed.activeWeekMode));
      setWeekView(parseWeekView(parsed.weekView));
    } catch {
      // Ignore malformed localStorage payloads and continue with defaults.
    } finally {
      setIsStorageHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isStorageHydrated) {
      return;
    }

    const payload = {
      subjects,
      teachers,
      classes,
      timeslots,
      weekCalendarSetups,
      blocks,
      schedule,
      activeCalendarDay,
      activeTab,
      activeWeekSetupId,
      enableAlternatingWeeks,
      activeWeekMode,
      weekView,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    isStorageHydrated,
    subjects,
    teachers,
    classes,
    timeslots,
    weekCalendarSetups,
    blocks,
    schedule,
    activeCalendarDay,
    activeTab,
    activeWeekSetupId,
    enableAlternatingWeeks,
    activeWeekMode,
    weekView,
  ]);

  const sortedTimeslots = useMemo(() => {
    return [...timeslots].sort((a, b) => {
      const dayCmp = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
      if (dayCmp !== 0) {
        return dayCmp;
      }
      const timeCmp = toMinutes(a.start_time) - toMinutes(b.start_time);
      if (timeCmp !== 0) {
        return timeCmp;
      }
      return a.period - b.period;
    });
  }, [timeslots]);

  const timeslotsByDay = useMemo(() => {
    const grouped: Record<string, Timeslot[]> = Object.fromEntries(calendarDays.map((day) => [day, []]));
    for (const slot of sortedTimeslots) {
      if (grouped[slot.day]) {
        grouped[slot.day].push(slot);
      }
    }
    return grouped;
  }, [sortedTimeslots]);

  const timeslotById = useMemo(() => {
    return Object.fromEntries(timeslots.map((t) => [t.id, t])) as Record<string, Timeslot>;
  }, [timeslots]);

  const sortedClasses = useMemo(() => {
    return [...classes].sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);

  const classNameById = useMemo(() => {
    return Object.fromEntries(sortedClasses.map((c) => [c.id, c.name])) as Record<string, string>;
  }, [sortedClasses]);

  // Template fellesfag: subjects that are the canonical definition (not a per-class copy).
  // A per-class copy has exactly 1 class_id. Templates have 0 or multiple class_ids.
  const fellesfagTemplates = useMemo(() => {
    const allFellesfag = subjects.filter((s) => s.subject_type === "fellesfag");
    const seen = new Set<string>();
    return allFellesfag
      .filter((s) => s.class_ids.length !== 1)
      .filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [subjects]);

  // All fellesfag subjects (templates + per-class copies) — used in Classes tab list.
  const fellesfagSubjects = useMemo(() => {
    return [...subjects]
      .filter((subject) => subject.subject_type === "fellesfag")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [subjects]);

  // Subjects tab only shows templates: fellesfag templates + programfag (always shared).
  // For each template, derive which classes are assigned via per-class copies.
  const subjectTabEntries = useMemo(() => {
    // Build a map: subjectName -> [classIds] from per-class copies
    const assignedByName = new Map<string, string[]>();
    for (const s of subjects) {
      if (s.subject_type === "fellesfag" && s.class_ids.length === 1) {
        const existing = assignedByName.get(s.name) ?? [];
        assignedByName.set(s.name, [...existing, s.class_ids[0]]);
      }
    }

    // Templates: fellesfag with class_ids.length !== 1, and all programfag
    return subjects
      .filter((s) => s.subject_type === "programfag" || s.class_ids.length !== 1)
      .map((s) => ({
        subject: s,
        // For fellesfag templates, show derived assigned classes
        derivedClassIds:
          s.subject_type === "fellesfag"
            ? (assignedByName.get(s.name) ?? [])
            : s.class_ids,
      }))
      .sort((a, b) => a.subject.name.localeCompare(b.subject.name));
  }, [subjects]);

  const timelineMarks = useMemo(() => {
    const marks = new Set<number>([DAY_START_MINUTES, DAY_END_MINUTES]);
    for (const ts of timeslots) {
      const start = toMinutes(ts.start_time);
      const end = toMinutes(ts.end_time);
      if (start !== Number.MAX_SAFE_INTEGER && start >= DAY_START_MINUTES && start <= DAY_END_MINUTES) {
        marks.add(start);
      }
      if (end !== Number.MAX_SAFE_INTEGER && end >= DAY_START_MINUTES && end <= DAY_END_MINUTES) {
        marks.add(end);
      }
    }
    return Array.from(marks).sort((a, b) => a - b);
  }, [timeslots]);

  const weekSlotLayouts = useMemo(() => {
    const byDay: Record<string, Record<string, { col: number; count: number }>> = {};
    for (const day of calendarDays) {
      byDay[day] = computeDaySlotLayout(timeslotsByDay[day] || []);
    }
    return byDay;
  }, [timeslotsByDay]);

  const weekColumnMarks = useMemo(() => {
    const marks: number[] = [];
    for (let minutes = DAY_START_MINUTES; minutes <= DAY_END_MINUTES; minutes += 60) {
      marks.push(minutes);
    }
    return marks;
  }, []);

  useEffect(() => {
    timeslotsRef.current = timeslots;
  }, [timeslots]);

  function applyNormalizedTimeslotState(nextTimeslots: Timeslot[], focusTimeslotId?: string | null): string | null {
    const { normalizedTimeslots, idMap } = normalizeTimeslotIds(nextTimeslots);
    const remapId = (id: string): string => idMap[id] ?? id;

    setTimeslots(normalizedTimeslots);

    setBlocks((prev) => prev.map((block) => ({
      ...block,
      timeslot_ids: Array.from(new Set(block.timeslot_ids.map(remapId))),
    })));

    setTeachers((prev) => prev.map((teacher) => ({
      ...teacher,
      unavailable_timeslots: Array.from(new Set(teacher.unavailable_timeslots.map(remapId))),
    })));

    setSubjects((prev) => prev.map((subject) => ({
      ...subject,
      allowed_timeslots: subject.allowed_timeslots
        ? Array.from(new Set(subject.allowed_timeslots.map(remapId)))
        : undefined,
    })));

    setSchedule((prev) => prev.map((item) => ({
      ...item,
      timeslot_id: remapId(item.timeslot_id),
    })));

    setEditingTimeslotId((prev) => (prev ? remapId(prev) : null));
    setDraggingTimeslotId((prev) => (prev ? remapId(prev) : null));
    setResizeState((prev) => (prev ? { ...prev, timeslotId: remapId(prev.timeslotId) } : null));

    if (focusTimeslotId) {
      return remapId(focusTimeslotId);
    }
    return null;
  }

  useEffect(() => {
    if (!resizeState) {
      return;
    }
    const activeResize = resizeState;

    function clamp(value: number, min: number, max: number): number {
      return Math.min(max, Math.max(min, value));
    }

    function snapToFive(minutes: number): number {
      return Math.round(minutes / 5) * 5;
    }

    function handleMouseMove(e: MouseEvent) {
      const y = clamp(e.clientY - activeResize.containerTop, 0, activeResize.containerHeight);
      const ratio = activeResize.containerHeight <= 0 ? 0 : y / activeResize.containerHeight;
      const rawMinutes = DAY_START_MINUTES + ratio * TIMELINE_TOTAL_MINUTES;
      const snappedMinutes = clamp(snapToFive(rawMinutes), DAY_START_MINUTES, DAY_END_MINUTES);

      setTimeslots((prev) => {
        const slot = prev.find((t) => t.id === activeResize.timeslotId);
        if (!slot) {
          return prev;
        }

        const start = toMinutes(slot.start_time);
        const end = toMinutes(slot.end_time);
        if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER) {
          return prev;
        }

        let nextStart = start;
        let nextEnd = end;

        if (activeResize.edge === "start") {
          nextStart = clamp(snappedMinutes, DAY_START_MINUTES, nextEnd - 5);
        } else {
          nextEnd = clamp(snappedMinutes, nextStart + 5, DAY_END_MINUTES);
        }

        const nextStartTime = minutesToTime(nextStart);
        const nextEndTime = minutesToTime(nextEnd);

        if (editingTimeslotId === activeResize.timeslotId) {
          setTimeslotForm((form) => ({
            ...form,
            start_time: nextStartTime,
            end_time: nextEndTime,
          }));
        }

        return prev.map((t) => {
          if (t.id !== activeResize.timeslotId) {
            return t;
          }
          return {
            ...t,
            start_time: nextStartTime,
            end_time: nextEndTime,
          };
        });
      });
    }

    function handleMouseUp() {
      applyNormalizedTimeslotState(timeslotsRef.current, activeResize.timeslotId);
      setResizeState(null);
      setStatusText("Timeslot duration updated.");
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizeState, editingTimeslotId]);

  function addTeacher() {
    if (!teacherForm.name) {
      return;
    }
    const id = makeUniqueId(`teacher_${toSlug(teacherForm.name) || "item"}`, teachers.map((t) => t.id));
    setTeachers((prev) => [
      ...prev,
      {
        id,
        name: teacherForm.name,
        unavailable_timeslots: splitCsv(teacherForm.unavailable_timeslots),
      },
    ]);
    setTeacherForm({ name: "", unavailable_timeslots: "" });
  }

  function addClass() {
    if (!classForm.name) {
      return;
    }
    const id = makeUniqueId(`class_${toSlug(classForm.name) || "item"}`, classes.map((c) => c.id));
    setClasses((prev) => [...prev, { id, name: classForm.name }]);
    if (classForm.setupId) {
      assignClassesToSetup([id], classForm.setupId);
    }
    setClassForm({ name: "", setupId: "" });
  }

  function assignClassesToSetup(classIds: string[], setupId: string) {
    if (!classIds.length) {
      return;
    }

    setWeekCalendarSetups((prev) => prev.map((setup) => {
      const filtered = setup.class_ids.filter((id) => !classIds.includes(id));
      if (!setupId) {
        return { ...setup, class_ids: filtered };
      }
      if (setup.id === setupId) {
        return { ...setup, class_ids: [...filtered, ...classIds] };
      }
      return { ...setup, class_ids: filtered };
    }));
  }

  function removeClass(classId: string) {
    const className = classes.find((c) => c.id === classId)?.name ?? classId;

    setClasses((prev) => prev.filter((c) => c.id !== classId));

    setWeekCalendarSetups((prev) => prev.map((setup) => ({
      ...setup,
      class_ids: setup.class_ids.filter((id) => id !== classId),
    })));

    setBlocks((prev) => prev.map((block) => ({
      ...block,
      class_ids: (block.class_ids ?? []).filter((id) => id !== classId),
    })));

    setSubjects((prev) => prev
      .map((subject) => ({
        ...subject,
        class_ids: subject.class_ids.filter((id) => id !== classId),
      }))
      .filter((subject) => subject.class_ids.length > 0));

    setSchedule((prev) => prev
      .map((item) => ({
        ...item,
        class_ids: item.class_ids.filter((id) => id !== classId),
      }))
      .filter((item) => item.class_ids.length > 0));

    setBlockForm((prev) => ({
      ...prev,
      class_ids: prev.class_ids.filter((id) => id !== classId),
    }));

    setFellesfagSelectionByClass((prev) => {
      if (!(classId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[classId];
      return next;
    });

    if (expandedClassId === classId) {
      setExpandedClassId(null);
    }

    setStatusText(`Deleted class ${className}.`);
  }

  function bulkAddClasses() {
    const years = Number(bulkClassForm.years);
    const classesPerYear = Number(bulkClassForm.classesPerYear);
    const abbreviation = bulkClassForm.abbreviation.trim().toUpperCase();

    if (!Number.isInteger(years) || years <= 0) {
      setStatusText("Trinn must be a positive whole number.");
      return;
    }
    if (!Number.isInteger(classesPerYear) || classesPerYear <= 0) {
      setStatusText("Classes per trinn must be a positive whole number.");
      return;
    }
    if (!abbreviation) {
      setStatusText("Forkortelse is required.");
      return;
    }

    const existingNames = new Set(classes.map((c) => c.name));
    const existingIds = classes.map((c) => c.id);
    const toAdd: SchoolClass[] = [];
    const skipped: string[] = [];

    for (let year = 1; year <= years; year += 1) {
      for (let classIndex = 0; classIndex < classesPerYear; classIndex += 1) {
        const suffix = classesPerYear === 1 ? "" : indexToLetters(classIndex);
        const className = `${year}${abbreviation}${suffix}`;

        if (existingNames.has(className)) {
          skipped.push(className);
          continue;
        }

        existingNames.add(className);
        const id = makeUniqueId(
          `class_${toSlug(className) || "item"}`,
          [...existingIds, ...toAdd.map((c) => c.id)],
        );
        toAdd.push({ id, name: className });
      }
    }

    if (!toAdd.length) {
      setStatusText("No new classes were added (all generated names already exist).");
      return;
    }

    setClasses((prev) => [...prev, ...toAdd]);

    if (bulkClassForm.setupId) {
      assignClassesToSetup(
        toAdd.map((c) => c.id),
        bulkClassForm.setupId,
      );
    }

    if (skipped.length) {
      setStatusText(`Added ${toAdd.length} classes, skipped ${skipped.length} existing.`);
    } else {
      setStatusText(`Added ${toAdd.length} classes.`);
    }
  }

  function saveCurrentWeekSetup() {
    if (!weekSetupForm.name.trim()) {
      setStatusText("Provide a setup name before saving.");
      return;
    }
    if (!timeslots.length) {
      setStatusText("Add at least one timeslot before saving a setup.");
      return;
    }

    const snapshot = timeslots.map((slot) => ({ ...slot }));
    const { normalizedTimeslots } = normalizeTimeslotIds(snapshot);

    if (activeWeekSetupId && weekCalendarSetups.some((setup) => setup.id === activeWeekSetupId)) {
      setWeekCalendarSetups((prev) => prev.map((setup) => {
        if (setup.id !== activeWeekSetupId) {
          return setup;
        }
        return {
          ...setup,
          name: weekSetupForm.name.trim(),
          timeslots: normalizedTimeslots,
        };
      }));
      setStatusText(`Updated week setup ${activeWeekSetupId}.`);
      return;
    }

    const setupId = makeUniqueId(
      `setup_${toSlug(weekSetupForm.name) || "item"}`,
      weekCalendarSetups.map((setup) => setup.id),
    );

    setWeekCalendarSetups((prev) => [
      ...prev,
      {
        id: setupId,
        name: weekSetupForm.name.trim(),
        timeslots: normalizedTimeslots,
        class_ids: [],
      },
    ]);

    setActiveWeekSetupId(setupId);
    setStatusText(`Saved week setup ${setupId}.`);
  }

  function applyWeekSetup(setupId: string) {
    const setup = weekCalendarSetups.find((x) => x.id === setupId);
    if (!setup) {
      return;
    }

    const snapshot = setup.timeslots.map((slot) => ({ ...slot }));
    const { normalizedTimeslots } = normalizeTimeslotIds(snapshot);
    setTimeslots(normalizedTimeslots);
    setSchedule([]);
    setEditingTimeslotId(null);
    setDraggingTimeslotId(null);
    setResizeState(null);

    const firstDay = normalizedTimeslots[0]?.day;
    if (firstDay && calendarDays.includes(firstDay)) {
      setActiveCalendarDay(firstDay);
      setTimeslotForm((s) => ({ ...s, day: firstDay }));
    }

    setActiveWeekSetupId(setup.id);
    setWeekSetupForm({
      name: setup.name,
    });

    setStatusText(`Applied week setup ${setup.name}.`);
  }

  function deleteWeekSetup(setupId: string) {
    setWeekCalendarSetups((prev) => prev.filter((setup) => setup.id !== setupId));
    if (activeWeekSetupId === setupId) {
      setActiveWeekSetupId(null);
      setWeekSetupForm({ name: "" });
    }
    if (renamingWeekSetupId === setupId) {
      setRenamingWeekSetupId(null);
      setRenameDraft("");
    }
    setStatusText(`Deleted week setup ${setupId}.`);
  }

  function getSetupIdForClass(classId: string): string {
    const found = weekCalendarSetups.find((setup) => setup.class_ids.includes(classId));
    return found?.id ?? "";
  }

  function assignClassToSetup(classId: string, setupId: string) {
    const className = classes.find((c) => c.id === classId)?.name ?? classId;
    assignClassesToSetup([classId], setupId);

    if (setupId) {
      const target = weekCalendarSetups.find((setup) => setup.id === setupId);
      setStatusText(`Assigned class ${className} to ${target?.name ?? setupId}.`);
      return;
    }

    setStatusText(`Cleared setup assignment for class ${className}.`);
  }

  function addFellesfagToClass(classId: string, subjectId: string) {
    if (!subjectId) {
      return;
    }

    const className = classes.find((c) => c.id === classId)?.name ?? classId;
    const template = subjects.find((s) => s.id === subjectId && s.subject_type === "fellesfag");
    if (!template) {
      return;
    }

    // Check if a per-class copy already exists for this class + subject name
    const alreadyExists = subjects.some(
      (s) => s.subject_type === "fellesfag" &&
        s.name === template.name &&
        s.class_ids.length === 1 &&
        s.class_ids[0] === classId
    );
    if (alreadyExists) {
      setStatusText(`${template.name} is already assigned to ${className}.`);
      return;
    }

    // Create an independent per-class copy so each class gets its own scheduled slot
    const newId = makeUniqueId(
      `subject_${toSlug(template.name)}_${toSlug(className)}`,
      subjects.map((s) => s.id),
    );
    const copy: Subject = {
      ...template,
      id: newId,
      class_ids: [classId],
    };

    setSubjects((prev) => [...prev, copy]);
    setStatusText(`Added fellesfag ${template.name} to ${className} (independent lesson).`);
  }

  function removeFellesfagFromClass(classId: string, subjectId: string) {
    const className = classes.find((c) => c.id === classId)?.name ?? classId;
    const subject = subjects.find((s) => s.id === subjectId);
    const subjectName = subject?.name ?? subjectId;

    // Remove the per-class copy entirely
    setSubjects((prev) => prev.filter((s) => s.id !== subjectId));
    setBlocks((prev) => prev.map((block) => ({
      ...block,
      subject_ids: (block.subject_ids ?? []).filter((id) => id !== subjectId),
    })));

    setStatusText(`Removed fellesfag ${subjectName} from ${className}.`);
  }

  function duplicateFellesfagToClasses(sourceClassId: string, targetClassIds: string[]) {
    if (!targetClassIds.length) {
      return;
    }

    // Collect per-class copies that belong to the source class
    const sourceCopies = subjects.filter(
      (s) => s.subject_type === "fellesfag" && s.class_ids.length === 1 && s.class_ids[0] === sourceClassId,
    );

    if (!sourceCopies.length) {
      setStatusText("No fellesfag assigned to this class to duplicate.");
      return;
    }

    const sourceClassName = classes.find((c) => c.id === sourceClassId)?.name ?? sourceClassId;

    setSubjects((prev) => {
      let next = [...prev];
      const existingIds = next.map((s) => s.id);

      for (const targetClassId of targetClassIds) {
        for (const template of sourceCopies) {
          // Skip if a copy for that name + target already exists
          const alreadyExists = next.some(
            (s) =>
              s.subject_type === "fellesfag" &&
              s.name === template.name &&
              s.class_ids.length === 1 &&
              s.class_ids[0] === targetClassId,
          );
          if (alreadyExists) {
            continue;
          }

          const targetName = classes.find((c) => c.id === targetClassId)?.name ?? targetClassId;
          const newId = makeUniqueId(
            `subject_${toSlug(template.name)}_${toSlug(targetName)}`,
            [...existingIds, ...next.map((s) => s.id)],
          );

          next = [
            ...next,
            {
              ...template,
              id: newId,
              class_ids: [targetClassId],
            },
          ];
        }
      }

      return next;
    });

    const targetNames = targetClassIds
      .map((id) => classes.find((c) => c.id === id)?.name ?? id)
      .join(", ");
    setStatusText(`Duplicated fellesfag from ${sourceClassName} to: ${targetNames}.`);

    // Clear the selection after duplicating
    setDuplicateTargetsByClass((prev) => ({ ...prev, [sourceClassId]: [] }));
  }

  function cloneWeekSetup(setupId: string) {
    const source = weekCalendarSetups.find((setup) => setup.id === setupId);
    if (!source) {
      return;
    }

    const cloneId = makeUniqueId(
      `setup_${toSlug(source.name) || "item"}`,
      weekCalendarSetups.map((setup) => setup.id),
    );
    const clonedName = `${source.name} Copy`;
    const clonedTimeslots = source.timeslots.map((slot) => ({ ...slot }));

    setWeekCalendarSetups((prev) => [
      ...prev,
      {
        id: cloneId,
        name: clonedName,
        timeslots: clonedTimeslots,
        class_ids: [...source.class_ids],
      },
    ]);

    setActiveWeekSetupId(cloneId);
    setWeekSetupForm({
      name: clonedName,
    });

    const { normalizedTimeslots } = normalizeTimeslotIds(clonedTimeslots);
    setTimeslots(normalizedTimeslots);
    setStatusText(`Cloned setup ${source.id} to ${cloneId}.`);
  }

  function startInlineRename(setupId: string) {
    const target = weekCalendarSetups.find((setup) => setup.id === setupId);
    if (!target) {
      return;
    }

    setRenamingWeekSetupId(setupId);
    setRenameDraft(target.name);
  }

  function cancelInlineRename() {
    setRenamingWeekSetupId(null);
    setRenameDraft("");
  }

  function submitInlineRename(setupId: string) {
    const target = weekCalendarSetups.find((setup) => setup.id === setupId);
    if (!target) {
      return;
    }

    const nextName = renameDraft.trim();
    if (!nextName) {
      setStatusText("Setup name cannot be empty.");
      return;
    }

    setWeekCalendarSetups((prev) => prev.map((setup) => {
      if (setup.id !== setupId) {
        return setup;
      }
      return {
        ...setup,
        name: nextName,
      };
    }));

    if (activeWeekSetupId === setupId) {
      setWeekSetupForm((s) => ({ ...s, name: nextName }));
    }

    setRenamingWeekSetupId(null);
    setRenameDraft("");
    setStatusText(`Renamed setup ${setupId}.`);
  }

  function addTimeslot(targetDay?: string) {
    const day = targetDay ?? timeslotForm.day;
    const start24 = normalizeTime24(timeslotForm.start_time);
    const end24 = normalizeTime24(timeslotForm.end_time);

    if (!day || !start24 || !end24) {
      return;
    }
    const startMinutes = toMinutes(start24);
    const endMinutes = toMinutes(end24);
    if (startMinutes === Number.MAX_SAFE_INTEGER || endMinutes === Number.MAX_SAFE_INTEGER) {
      setStatusText("Invalid time format. Use 24-hour format HH:MM (example: 13:30).");
      return;
    }
    if (startMinutes >= endMinutes) {
      setStatusText("Invalid timeslot: finish time must be later than start time.");
      return;
    }

    const id = `tmp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const dayPeriod = timeslots.filter((t) => t.day === day).length + 1;
    const nextTimeslots = [
      ...timeslots,
      {
        id,
        day,
        period: dayPeriod,
        start_time: start24,
        end_time: end24,
        is_double: timeslotForm.is_double,
        is_idrett: timeslotForm.is_idrett,
        is_lunch: timeslotForm.is_lunch,
      },
    ];
    const normalizedId = applyNormalizedTimeslotState(nextTimeslots, id) ?? id;
    setTimeslotForm((s) => ({ ...s, start_time: start24, end_time: end24 }));
    setStatusText(`Added timeslot ${normalizedId}.`);
  }

  function startEditTimeslot(slot: Timeslot) {
    setEditingTimeslotId(slot.id);
    setActiveCalendarDay(slot.day);
    setTimeslotForm({
      day: slot.day,
      start_time: slot.start_time ?? "08:00",
      end_time: slot.end_time ?? "08:45",
      is_double: Boolean(slot.is_double),
      is_idrett: Boolean(slot.is_idrett),
      is_lunch: Boolean(slot.is_lunch),
    });
    setStatusText(`Editing timeslot ${slot.id}.`);
  }

  function cancelEditTimeslot() {
    setEditingTimeslotId(null);
    setTimeslotForm((s) => ({
      ...s,
      day: activeCalendarDay,
      start_time: "08:00",
      end_time: "08:45",
      is_double: false,
      is_idrett: false,
      is_lunch: false,
    }));
    setStatusText("Timeslot editing cancelled.");
  }

  function updateTimeslot(timeslotId: string, targetDay?: string) {
    const day = targetDay ?? timeslotForm.day;
    const start24 = normalizeTime24(timeslotForm.start_time);
    const end24 = normalizeTime24(timeslotForm.end_time);

    if (!day || !start24 || !end24) {
      return;
    }

    const startMinutes = toMinutes(start24);
    const endMinutes = toMinutes(end24);
    if (startMinutes === Number.MAX_SAFE_INTEGER || endMinutes === Number.MAX_SAFE_INTEGER) {
      setStatusText("Invalid time format. Use 24-hour format HH:MM (example: 13:30).");
      return;
    }
    if (startMinutes >= endMinutes) {
      setStatusText("Invalid timeslot: finish time must be later than start time.");
      return;
    }

    const dayPeriod = timeslots.filter((t) => t.day === day && t.id !== timeslotId).length + 1;

    const nextTimeslots = timeslots.map((slot) => {
      if (slot.id !== timeslotId) {
        return slot;
      }
      return {
        ...slot,
        day,
        period: dayPeriod,
        start_time: start24,
        end_time: end24,
        is_double: timeslotForm.is_double,
        is_idrett: timeslotForm.is_idrett,
        is_lunch: timeslotForm.is_lunch,
      };
    });

    const normalizedId = applyNormalizedTimeslotState(nextTimeslots, timeslotId) ?? timeslotId;

    setTimeslotForm((s) => ({ ...s, day, start_time: start24, end_time: end24 }));
    setActiveCalendarDay(day);
    setEditingTimeslotId(null);
    setStatusText(`Updated timeslot ${normalizedId}.`);
  }

  function addBlock() {
    if (!blockForm.name) {
      return;
    }
    const selectedClassIds = blockForm.class_ids.filter((id) => classes.some((c) => c.id === id));
    const selectedSubjectIds = blockForm.subject_ids.filter((id) => subjects.some((s) => s.id === id));

    const id = makeUniqueId(`block_${toSlug(blockForm.name) || "item"}`, blocks.map((b) => b.id));
    setBlocks((prev) => [
      ...prev,
      {
        id,
        name: blockForm.name,
        timeslot_ids: splitCsv(blockForm.timeslot_ids),
        week_pattern: blockForm.week_pattern,
        a_week_lessons: Number(blockForm.a_week_lessons) || 0,
        b_week_lessons: Number(blockForm.b_week_lessons) || 0,
        class_ids: selectedClassIds,
        subject_ids: selectedSubjectIds,
      },
    ]);
    setBlockForm({
      name: "",
      timeslot_ids: "",
      week_pattern: "both",
      a_week_lessons: "5",
      b_week_lessons: "5",
      class_ids: [],
      subject_ids: [],
    });
  }

  function removeTimeslot(timeslotId: string) {
    const remaining = timeslots.filter((slot) => slot.id !== timeslotId);
    const { normalizedTimeslots, idMap } = normalizeTimeslotIds(remaining);
    const remapId = (id: string): string => idMap[id] ?? id;

    setTimeslots(normalizedTimeslots);
    setSchedule((prev) => prev
      .filter((item) => item.timeslot_id !== timeslotId)
      .map((item) => ({ ...item, timeslot_id: remapId(item.timeslot_id) })));

    setBlocks((prev) => prev.map((block) => ({
      ...block,
      timeslot_ids: Array.from(new Set(block.timeslot_ids.filter((id) => id !== timeslotId).map(remapId))),
    })));

    setTeachers((prev) => prev.map((teacher) => ({
      ...teacher,
      unavailable_timeslots: Array.from(
        new Set(teacher.unavailable_timeslots.filter((id) => id !== timeslotId).map(remapId)),
      ),
    })));

    setSubjects((prev) => prev.map((subject) => ({
      ...subject,
      allowed_timeslots: subject.allowed_timeslots
        ? Array.from(new Set(subject.allowed_timeslots.filter((id) => id !== timeslotId).map(remapId)))
        : undefined,
    })));

    if (editingTimeslotId === timeslotId) {
      setEditingTimeslotId(null);
    } else if (editingTimeslotId) {
      setEditingTimeslotId(remapId(editingTimeslotId));
    }
    if (resizeState?.timeslotId === timeslotId) {
      setResizeState(null);
    } else if (resizeState) {
      setResizeState({ ...resizeState, timeslotId: remapId(resizeState.timeslotId) });
    }
    if (draggingTimeslotId === timeslotId) {
      setDraggingTimeslotId(null);
    } else if (draggingTimeslotId) {
      setDraggingTimeslotId(remapId(draggingTimeslotId));
    }

    setStatusText(`Deleted timeslot ${timeslotId}.`);
  }

  function startResizeFromHandle(
    e: React.MouseEvent<HTMLSpanElement>,
    timeslotId: string,
    edge: "start" | "end",
  ) {
    e.stopPropagation();
    e.preventDefault();
    const daySlots = e.currentTarget.closest(".day-slots");
    if (!daySlots) {
      return;
    }
    const rect = daySlots.getBoundingClientRect();
    setResizeState({
      timeslotId,
      edge,
      containerTop: rect.top,
      containerHeight: rect.height,
    });
  }

  function addSubjectCard() {
    const name = subjectForm.name.trim();
    if (!name) {
      setStatusText("Enter a subject name first.");
      return;
    }

    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((s) => s.id));
    setSubjects((prev) => [
      ...prev,
      {
        id,
        name,
        teacher_id: "",
        class_ids: [],
        subject_type: "fellesfag",
        sessions_per_week: 1,
      },
    ]);

    setSubjectForm({ name: "" });
    setStatusText(`Added subject card ${name}.`);
  }

  function updateSubjectCard(subjectId: string, patch: Partial<Subject>) {
    setSubjects((prev) => prev.map((subject) => {
      if (subject.id !== subjectId) {
        return subject;
      }

      const merged = { ...subject, ...patch };
      const cleanedClassIds = merged.class_ids.filter((id) => classes.some((c) => c.id === id));
      return {
        ...merged,
        class_ids: cleanedClassIds,
        sessions_per_week: Math.max(1, Math.floor(merged.sessions_per_week || 1)),
      };
    }));
  }

  function deleteSubjectCard(subjectId: string) {
    // Find the template so we can also remove all per-class copies with the same name
    const template = subjects.find((s) => s.id === subjectId);
    const toRemove = new Set<string>([subjectId]);

    if (template) {
      // Per-class copies: same name + subject_type, class_ids.length === 1
      for (const s of subjects) {
        if (
          s.id !== subjectId &&
          s.name === template.name &&
          s.subject_type === template.subject_type &&
          s.class_ids.length === 1
        ) {
          toRemove.add(s.id);
        }
      }
    }

    setSubjects((prev) => prev.filter((s) => !toRemove.has(s.id)));
    setBlocks((prev) => prev.map((block) => ({
      ...block,
      subject_ids: (block.subject_ids ?? []).filter((id) => !toRemove.has(id)),
    })));
    setStatusText(`Deleted subject and ${toRemove.size - 1} class assignment(s).`);
  }

  async function generateSchedule() {
    setLoading(true);
    setStatusText("Generating schedule...");
    setSchedule([]);

    try {
      const payload = {
        subjects,
        teachers,
        classes,
        timeslots,
        alternating_weeks_enabled: enableAlternatingWeeks,
        blocks: blocks.map((block) => ({
          id: block.id,
          name: block.name,
          timeslot_ids: block.timeslot_ids,
          week_pattern: block.week_pattern,
          class_ids: block.class_ids ?? [],
          subject_ids: block.subject_ids ?? [],
        })),
      };

      const res = await fetch(`${API_BASE}/generate-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      }

      const data: GenerateResponse = await res.json();
      setStatusText(data.message);
      setSchedule(data.schedule || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatusText(`Failed: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  const activeTabIndex = workflowTabs.findIndex((tab) => tab.id === activeTab);

  function goToNextTab() {
    if (activeTabIndex >= workflowTabs.length - 1) {
      return;
    }
    setActiveTab(workflowTabs[activeTabIndex + 1].id);
  }

  function goToPreviousTab() {
    if (activeTabIndex <= 0) {
      return;
    }
    setActiveTab(workflowTabs[activeTabIndex - 1].id);
  }

  return (
    <main>
      <section className="hero">
        <h1>School Scheduling Studio</h1>
        <p>
          Build entities, define constraints, and generate a valid timetable with a CP-SAT solver.
          This version keeps data in memory for rapid iteration.
        </p>
      </section>

      <section className="tab-strip" aria-label="Workflow tabs">
        {workflowTabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{index + 1}</span>
            {tab.label}
          </button>
        ))}
      </section>

      <section className="tab-controls">
        <button type="button" className="secondary" onClick={goToPreviousTab} disabled={activeTabIndex === 0}>
          Previous
        </button>
        <div className="status">Step {activeTabIndex + 1} of {workflowTabs.length}</div>
        <button type="button" className="secondary" onClick={goToNextTab} disabled={activeTabIndex === workflowTabs.length - 1}>
          Next
        </button>
      </section>

      {activeTab === "calendar" && (
      <section className="card week-calendar">
        <h2>Week Calendar (Monday-Friday)</h2>
        <p>Click a day column to select it, set start and finish, then press Enter or Add Timeslot.</p>

        <section className="week-setup-manager">
          <h3>Week Calendar Setups</h3>
          <p>Save multiple weekly variations and assign them to classes.</p>
          <form
            className="week-setup-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveCurrentWeekSetup();
            }}
          >
            <div className="calendar-field">
              <label>Setup Name</label>
              <input
                value={weekSetupForm.name}
                onChange={(e) => setWeekSetupForm((s) => ({ ...s, name: e.target.value }))}
                placeholder="Example: Science-heavy week"
              />
            </div>

            <button type="submit" className="calendar-submit">
              {activeWeekSetupId ? "Save Changes To Active Setup" : "Save Current Week As Setup"}
            </button>
          </form>

          <div className="week-setup-toolbar">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setActiveWeekSetupId(null);
                setWeekSetupForm({ name: "" });
                setStatusText("Ready to create a new week setup.");
              }}
            >
              New Setup
            </button>
            {activeWeekSetupId ? <div className="status">Active setup: {activeWeekSetupId}</div> : null}
          </div>

          <div className="list week-setup-list">
            {weekCalendarSetups.map((setup) => (
              <div
                key={setup.id}
                className={`item week-setup-item ${activeWeekSetupId === setup.id ? "active" : ""}`}
                onClick={() => {
                  if (renamingWeekSetupId === setup.id) {
                    return;
                  }
                  applyWeekSetup(setup.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (renamingWeekSetupId === setup.id) {
                    return;
                  }
                  if (e.key === "Enter") {
                    applyWeekSetup(setup.id);
                  }
                }}
              >
                <div>
                  {renamingWeekSetupId === setup.id ? (
                    <div className="week-setup-rename-inline" onClick={(e) => e.stopPropagation()}>
                      <input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitInlineRename(setup.id);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelInlineRename();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          submitInlineRename(setup.id);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelInlineRename();
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <strong>{setup.name}</strong>
                  )} ({setup.id})
                  <div>
                    Slots: {setup.timeslots.length} | Classes: {setup.class_ids.length
                      ? setup.class_ids.map((id) => classNameById[id] ?? id).join(", ")
                      : "none assigned"}
                  </div>
                </div>
                <div className="week-setup-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      cloneWeekSetup(setup.id);
                    }}
                  >
                    Clone
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      startInlineRename(setup.id);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteWeekSetup(setup.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <form
          className="calendar-controls"
          onSubmit={(e) => {
            e.preventDefault();
            if (editingTimeslotId) {
              updateTimeslot(editingTimeslotId, activeCalendarDay);
              return;
            }
            addTimeslot(activeCalendarDay);
          }}
        >
          <div className="calendar-field day-field">
            <label>Selected Day</label>
            <select
              value={activeCalendarDay}
              onChange={(e) => {
                setActiveCalendarDay(e.target.value);
                setTimeslotForm((s) => ({ ...s, day: e.target.value }));
              }}
            >
              {calendarDays.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </div>

          <div className="calendar-field time-field">
            <label>Start</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="08:00"
              pattern="^([01]?\d|2[0-3]):[0-5]\d$"
              title="Use 24-hour format HH:MM"
              value={timeslotForm.start_time}
              onChange={(e) => setTimeslotForm((s) => ({ ...s, start_time: e.target.value }))}
              onBlur={(e) => setTimeslotForm((s) => ({ ...s, start_time: normalizeTime24(e.target.value) }))}
            />
          </div>

          <div className="calendar-field time-field">
            <label>Finish</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="08:45"
              pattern="^([01]?\d|2[0-3]):[0-5]\d$"
              title="Use 24-hour format HH:MM"
              value={timeslotForm.end_time}
              onChange={(e) => setTimeslotForm((s) => ({ ...s, end_time: e.target.value }))}
              onBlur={(e) => setTimeslotForm((s) => ({ ...s, end_time: normalizeTime24(e.target.value) }))}
            />
          </div>

          <label className="calendar-check">
            <input
              type="checkbox"
              checked={timeslotForm.is_double}
              onChange={(e) => setTimeslotForm((s) => ({ ...s, is_double: e.target.checked }))}
            />
            Double class (visual split, counts as one)
          </label>

          <label className="calendar-check">
            <input
              type="checkbox"
              checked={timeslotForm.is_idrett}
              onChange={(e) => setTimeslotForm((s) => ({ ...s, is_idrett: e.target.checked }))}
            />
            Idrett (green in schedule)
          </label>

          <label className="calendar-check">
            <input
              type="checkbox"
              checked={timeslotForm.is_lunch}
              onChange={(e) => setTimeslotForm((s) => ({ ...s, is_lunch: e.target.checked }))}
            />
            Lunch (yellow in schedule)
          </label>

          <button className="calendar-submit" type="submit">
            {editingTimeslotId ? "Save Changes" : "Add Timeslot"}
          </button>
        </form>

        {editingTimeslotId && (
          <div className="calendar-editing-row">
            <div className="calendar-editing-note">Editing slot: {editingTimeslotId}</div>
            <button type="button" className="secondary calendar-cancel-edit" onClick={cancelEditTimeslot}>
              Cancel Edit
            </button>
          </div>
        )}

        <div
          className={`timeslot-delete-zone ${isDeleteZoneActive ? "drag-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDeleteZoneActive(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDeleteZoneActive(true);
          }}
          onDragLeave={() => setIsDeleteZoneActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingTimeslotId) {
              removeTimeslot(draggingTimeslotId);
            }
            setDraggingTimeslotId(null);
            setIsDeleteZoneActive(false);
          }}
        >
          Drag a timeslot here to delete it
        </div>

        <div className="week-grid">
          {calendarDays.map((day) => (
            <article
              key={day}
              className={`day-column ${activeCalendarDay === day ? "active" : ""}`}
              onClick={() => {
                setActiveCalendarDay(day);
                setTimeslotForm((s) => ({ ...s, day }));
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setActiveCalendarDay(day);
                  setTimeslotForm((s) => ({ ...s, day }));
                }
              }}
            >
              <header>
                <h3>{day}</h3>
                <button
                  type="button"
                  className="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (editingTimeslotId) {
                      updateTimeslot(editingTimeslotId, day);
                      return;
                    }
                    addTimeslot(day);
                  }}
                >
                  {editingTimeslotId ? "Save" : "Add"}
                </button>
              </header>
              <div className="day-slots">
                {weekColumnMarks.map((minutes) => {
                  const topPct = ((minutes - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                  return <div key={`${day}_${minutes}`} className="day-track-line" style={{ top: `${topPct}%` }} />;
                })}

                {(timeslotsByDay[day] || []).map((slot) => (
                  (() => {
                    const start = toMinutes(slot.start_time);
                    const end = toMinutes(slot.end_time);
                    if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER) {
                      return null;
                    }

                    const clampedStart = Math.max(DAY_START_MINUTES, start);
                    const clampedEnd = Math.min(DAY_END_MINUTES, end);
                    if (clampedEnd <= clampedStart) {
                      return null;
                    }

                    const topPct = ((clampedStart - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                    const heightPct = ((clampedEnd - clampedStart) / TIMELINE_TOTAL_MINUTES) * 100;
                    const layout = weekSlotLayouts[day]?.[slot.id] ?? { col: 0, count: 1 };
                    const widthPct = 100 / Math.max(1, layout.count);
                    const leftPct = widthPct * layout.col;

                    return (
                      <div
                        key={slot.id}
                        className={`slot-pill ${getSlotToneClass(slot)}`}
                        draggable={!resizeState}
                        onDragStart={() => setDraggingTimeslotId(slot.id)}
                        onDragEnd={() => {
                          setDraggingTimeslotId(null);
                          setIsDeleteZoneActive(false);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditTimeslot(slot);
                        }}
                        style={{
                          top: `${topPct}%`,
                          height: `${Math.max(heightPct, 7)}%`,
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          right: "auto",
                        }}
                      >
                        <button
                          type="button"
                          className="slot-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTimeslot(slot.id);
                          }}
                          aria-label={`Delete timeslot ${slot.id}`}
                        >
                          x
                        </button>
                        <span
                          className="slot-resize-handle top"
                          onMouseDown={(e) => startResizeFromHandle(e, slot.id, "start")}
                          role="presentation"
                        />
                        <span
                          className="slot-resize-handle bottom"
                          onMouseDown={(e) => startResizeFromHandle(e, slot.id, "end")}
                          role="presentation"
                        />
                        {slot.is_double && getMidpointTime(slot.start_time, slot.end_time) ? (
                          <div className="slot-split">
                            <span>{slot.start_time}-{getMidpointTime(slot.start_time, slot.end_time)}</span>
                            <span>{getMidpointTime(slot.start_time, slot.end_time)}-{slot.end_time}</span>
                          </div>
                        ) : (
                          <div>{slot.start_time} - {slot.end_time}</div>
                        )}
                        <small>{slot.id}</small>
                      </div>
                    );
                  })()
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
      )}

      {activeTab === "classes" && (
      <section className="grid">
        <article className="card">
          <h2>Classes</h2>
          <p>Add teaching groups like 1STA, 1STB, 1STC and choose which week setup each class follows.</p>
          <form onSubmit={(e) => { e.preventDefault(); addClass(); }}>
            <label>Name</label>
            <input value={classForm.name} onChange={(e) => setClassForm((s) => ({ ...s, name: e.target.value }))} />
            <label>Calendar Setup (optional)</label>
            <select
              value={classForm.setupId}
              onChange={(e) => setClassForm((s) => ({ ...s, setupId: e.target.value }))}
            >
              <option value="">No setup assigned</option>
              {weekCalendarSetups.map((setup) => (
                <option key={setup.id} value={setup.id}>
                  {setup.name} ({setup.id})
                </option>
              ))}
            </select>
            <button type="submit">Add Class</button>
          </form>

          <form
            className="class-bulk-form"
            onSubmit={(e) => {
              e.preventDefault();
              bulkAddClasses();
            }}
          >
            <div className="calendar-field">
              <label>Trinn (Years)</label>
              <input
                type="number"
                min={1}
                value={bulkClassForm.years}
                onChange={(e) => setBulkClassForm((s) => ({ ...s, years: e.target.value }))}
              />
            </div>
            <div className="calendar-field">
              <label>Forkortelse</label>
              <input
                value={bulkClassForm.abbreviation}
                onChange={(e) => setBulkClassForm((s) => ({ ...s, abbreviation: e.target.value.toUpperCase() }))}
                placeholder="ST"
              />
            </div>
            <div className="calendar-field">
              <label>Classes Per Trinn</label>
              <input
                type="number"
                min={1}
                value={bulkClassForm.classesPerYear}
                onChange={(e) => setBulkClassForm((s) => ({ ...s, classesPerYear: e.target.value }))}
              />
            </div>
            <div className="calendar-field">
              <label>Calendar Setup (optional)</label>
              <select
                value={bulkClassForm.setupId}
                onChange={(e) => setBulkClassForm((s) => ({ ...s, setupId: e.target.value }))}
              >
                <option value="">No setup assigned</option>
                {weekCalendarSetups.map((setup) => (
                  <option key={setup.id} value={setup.id}>
                    {setup.name} ({setup.id})
                  </option>
                ))}
              </select>
            </div>
            <button type="submit">Mass Add Classes</button>
          </form>

          <div className="list classes-setup-list">
            {sortedClasses.map((c) => (
              <div
                key={c.id}
                className={`item class-expand-item ${expandedClassId === c.id ? "expanded" : ""}`}
              >
                <button
                  type="button"
                  className="class-expand-trigger"
                  onClick={() => setExpandedClassId((prev) => (prev === c.id ? null : c.id))}
                  aria-expanded={expandedClassId === c.id}
                >
                  <span className="class-expand-title">
                    {c.name}
                    {expandedClassId === c.id ? " (selected)" : ""}
                  </span>
                  <span className="class-expand-symbol">{expandedClassId === c.id ? "-" : "+"}</span>
                </button>

                {expandedClassId === c.id && (
                  <div className="class-expand-panel">
                    <div className="calendar-field">
                      <label>Calendar Setup</label>
                      <select
                        value={getSetupIdForClass(c.id)}
                        onChange={(e) => assignClassToSetup(c.id, e.target.value)}
                      >
                        <option value="">No setup assigned</option>
                        {weekCalendarSetups.map((setup) => (
                          <option key={setup.id} value={setup.id}>
                            {setup.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="calendar-field">
                      <label>Add Fellesfag</label>
                      <div className="class-setup-controls">
                        <select
                          value={fellesfagSelectionByClass[c.id] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFellesfagSelectionByClass((prev) => ({
                              ...prev,
                              [c.id]: value,
                            }));
                          }}
                        >
                          <option value="">Choose fellesfag</option>
                          {fellesfagTemplates.map((subject) => (
                            <option key={subject.id} value={subject.id}>
                              {subject.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => addFellesfagToClass(c.id, fellesfagSelectionByClass[c.id] ?? "")}
                          disabled={!fellesfagSelectionByClass[c.id]}
                        >
                          Add
                        </button>
                      </div>
                    </div>

                    <div className="class-fellesfag-list">
                      {fellesfagSubjects
                        .filter((subject) => subject.class_ids.length === 1 && subject.class_ids[0] === c.id)
                        .map((subject) => (
                          <div key={subject.id} className="class-fellesfag-item">
                            <span>{subject.name}</span>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => removeFellesfagFromClass(c.id, subject.id)}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                    </div>

                    {fellesfagSubjects.some(
                      (s) => s.class_ids.length === 1 && s.class_ids[0] === c.id,
                    ) && (
                      <div className="calendar-field">
                        <label>Duplicate Fellesfag To Other Classes</label>
                        <select
                          multiple
                          size={Math.min(Math.max(sortedClasses.filter((cl) => cl.id !== c.id).length, 3), 8)}
                          value={duplicateTargetsByClass[c.id] ?? []}
                          onChange={(e) => {
                            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                            setDuplicateTargetsByClass((prev) => ({ ...prev, [c.id]: selected }));
                          }}
                        >
                          {sortedClasses
                            .filter((cl) => cl.id !== c.id)
                            .map((cl) => (
                              <option key={cl.id} value={cl.id}>
                                {cl.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          disabled={!(duplicateTargetsByClass[c.id] ?? []).length}
                          onClick={() => duplicateFellesfagToClasses(c.id, duplicateTargetsByClass[c.id] ?? [])}
                        >
                          Duplicate to Selected Classes
                        </button>
                      </div>
                    )}

                    <button
                      type="button"
                      className="secondary"
                      onClick={() => removeClass(c.id)}
                    >
                      Delete Class
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </article>
      </section>
      )}

      {activeTab === "subjects" && (
      <section className="grid">
        <article className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Subjects</h2>
          <p>Add a subject name, then configure each subject card below.</p>
          <form onSubmit={(e) => { e.preventDefault(); addSubjectCard(); }}>
            <label>Subject Name</label>
            <input
              value={subjectForm.name}
              onChange={(e) => setSubjectForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="Geografi"
            />
            <button type="submit">Add Subject Card</button>
          </form>

          <div className="list subject-card-list">
            {subjectTabEntries.map(({ subject, derivedClassIds }) => (
              <article
                key={subject.id}
                className={`item subject-card-item${expandedSubjectId === subject.id ? " expanded" : ""}`}
              >
                <button
                  type="button"
                  className="subject-expand-trigger"
                  onClick={() => setExpandedSubjectId((prev) => (prev === subject.id ? null : subject.id))}
                  aria-expanded={expandedSubjectId === subject.id}
                >
                  <span className="subject-expand-summary">
                    <span className="subject-expand-name">{subject.name}</span>
                    <span className="subject-expand-meta">
                      {subject.subject_type === "fellesfag" ? "Fellesfag" : "Programfag"}
                      {" "}({subject.sessions_per_week}x45)
                    </span>
                    {derivedClassIds.length > 0 && (
                      <span className="subject-expand-chips">
                        {derivedClassIds.map((cid) => (
                          <span key={cid} className="subject-class-chip">
                            {classNameById[cid] ?? cid}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="subject-expand-symbol">{expandedSubjectId === subject.id ? "-" : "+"}</span>
                </button>

                {expandedSubjectId === subject.id && (
                  <div className="subject-expand-panel">
                    <div className="subject-card-grid">
                      <div className="calendar-field">
                        <label>Sessions Per Week (x45m)</label>
                        <input
                          type="number"
                          min={1}
                          value={subject.sessions_per_week}
                          onChange={(e) =>
                            updateSubjectCard(subject.id, {
                              sessions_per_week: Number(e.target.value) || 1,
                            })
                          }
                        />
                      </div>

                      <div className="calendar-field">
                        <label>Subject Type</label>
                        <select
                          value={subject.subject_type}
                          onChange={(e) =>
                            updateSubjectCard(subject.id, {
                              subject_type: e.target.value as "fellesfag" | "programfag",
                            })
                          }
                        >
                          <option value="fellesfag">Fellesfag</option>
                          <option value="programfag">Programfag</option>
                        </select>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="secondary"
                      onClick={() => deleteSubjectCard(subject.id)}
                    >
                      Delete Subject
                    </button>

                    {/* Teacher assignment per class entity */}
                    {(subject.subject_type === "programfag" ||
                      subjects.some(
                        (s) =>
                          s.subject_type === "fellesfag" &&
                          s.class_ids.length === 1 &&
                          s.name === subject.name
                      )) && (
                      <div className="subject-teacher-section">
                        <span className="subject-teacher-section-title">Teachers</span>
                        {subject.subject_type === "fellesfag" ? (
                          subjects
                            .filter(
                              (s) =>
                                s.subject_type === "fellesfag" &&
                                s.class_ids.length === 1 &&
                                s.name === subject.name
                            )
                            .sort((a, b) =>
                              (classNameById[a.class_ids[0]] ?? "").localeCompare(
                                classNameById[b.class_ids[0]] ?? ""
                              )
                            )
                            .map((entity) => (
                              <div key={entity.id} className="subject-teacher-row">
                                <span className="subject-teacher-classname">
                                  {classNameById[entity.class_ids[0]] ?? entity.class_ids[0]}
                                </span>
                                <select
                                  value={entity.teacher_id}
                                  onChange={(e) =>
                                    updateSubjectCard(entity.id, { teacher_id: e.target.value })
                                  }
                                >
                                  <option value="">— no teacher —</option>
                                  {teachers.map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))
                        ) : (
                          <div className="subject-teacher-row">
                            <select
                              value={subject.teacher_id}
                              onChange={(e) =>
                                updateSubjectCard(subject.id, { teacher_id: e.target.value })
                              }
                            >
                              <option value="">— no teacher —</option>
                              {teachers.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
        </article>
      </section>
      )}

      {activeTab === "blocks" && (
      <section className="grid">
        <article className="card">
          <h2>Blocks</h2>
          <p>Assign block timing, A/B week lesson count, and connected classes/subjects.</p>
          <form onSubmit={(e) => { e.preventDefault(); addBlock(); }}>
            <label>Name</label>
            <input value={blockForm.name} onChange={(e) => setBlockForm((s) => ({ ...s, name: e.target.value }))} />
            <label>Timeslot IDs in Block (comma-separated)</label>
            <input
              value={blockForm.timeslot_ids}
              onChange={(e) => setBlockForm((s) => ({ ...s, timeslot_ids: e.target.value }))}
            />
            <label>Week Pattern</label>
            <select
              value={blockForm.week_pattern}
              onChange={(e) => setBlockForm((s) => ({ ...s, week_pattern: parseWeekView(e.target.value) }))}
            >
              <option value="both">Both weeks</option>
              <option value="A">A-week only</option>
              <option value="B">B-week only</option>
            </select>
            <label>A-week lessons (x45m)</label>
            <input
              type="number"
              min={0}
              value={blockForm.a_week_lessons}
              onChange={(e) => setBlockForm((s) => ({ ...s, a_week_lessons: e.target.value }))}
            />
            <label>B-week lessons (x45m)</label>
            <input
              type="number"
              min={0}
              value={blockForm.b_week_lessons}
              onChange={(e) => setBlockForm((s) => ({ ...s, b_week_lessons: e.target.value }))}
            />
            <label>Classes in Block</label>
            <select
              multiple
              value={blockForm.class_ids}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions).map((option) => option.value);
                setBlockForm((s) => ({ ...s, class_ids: selected }));
              }}
            >
              {sortedClasses.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {cls.name}
                </option>
              ))}
            </select>
            <label>Subjects in Block</label>
            <select
              multiple
              value={blockForm.subject_ids}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions).map((option) => option.value);
                setBlockForm((s) => ({ ...s, subject_ids: selected }));
              }}
            >
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name} ({subject.id})
                </option>
              ))}
            </select>
            <button type="submit">Add Block</button>
          </form>
          <div className="list">
            {blocks
              .filter((block) => weekView === "both" || block.week_pattern === "both" || block.week_pattern === weekView)
              .map((b) => (
              <div key={b.id} className="item">
                {b.id} - {b.name} | {b.week_pattern ?? "both"} | A:{b.a_week_lessons ?? 0} x45 | B:{b.b_week_lessons ?? 0} x45
                {b.class_ids?.length ? ` | classes: ${b.class_ids.join(", ")}` : ""}
                {b.subject_ids?.length ? ` | subjects: ${b.subject_ids.join(", ")}` : ""}
              </div>
            ))}
          </div>
        </article>
      </section>
      )}

      {activeTab === "teachers" && (
      <section className="grid">
        <article className="card">
          <h2>Teachers</h2>
          <p>Add teachers here so they can be assigned to subjects.</p>
          <form onSubmit={(e) => { e.preventDefault(); addTeacher(); }}>
            <label>Name</label>
            <input value={teacherForm.name} onChange={(e) => setTeacherForm((s) => ({ ...s, name: e.target.value }))} />
            <label>Unavailable Timeslot IDs (comma-separated)</label>
            <input
              value={teacherForm.unavailable_timeslots}
              onChange={(e) => setTeacherForm((s) => ({ ...s, unavailable_timeslots: e.target.value }))}
            />
            <button type="submit">Add Teacher</button>
          </form>
          <div className="list">
            {teachers.map((t) => (
              <div key={t.id} className="item">
                {t.id} - {t.name}
              </div>
            ))}
          </div>
        </article>
      </section>
      )}

      {activeTab === "generate" && (
      <>
        <section className="card week-strategy">
          <h2>Scheduling Mode</h2>
          <p>
            Week setup stays the same. Use alternating A/B weeks during scheduling to distribute subjects
            differently across opposite weeks.
          </p>
          <div className="week-settings">
            <label className="calendar-check">
              <input
                type="checkbox"
                checked={enableAlternatingWeeks}
                onChange={(e) => setEnableAlternatingWeeks(e.target.checked)}
              />
              Enable alternating A/B week scheduling
            </label>

            <div className="calendar-field">
              <label>Current Week View</label>
              <select
                value={activeWeekMode}
                onChange={(e) => setActiveWeekMode(parseWeekMode(e.target.value))}
                disabled={!enableAlternatingWeeks}
              >
                <option value="A">A-week</option>
                <option value="B">B-week</option>
              </select>
            </div>

            <div className="calendar-field">
              <label>Display</label>
              <select
                value={weekView}
                onChange={(e) => setWeekView(parseWeekView(e.target.value))}
                disabled={!enableAlternatingWeeks}
              >
                <option value="both">Show both weeks</option>
                <option value="A">Show A-week only</option>
                <option value="B">Show B-week only</option>
              </select>
            </div>
          </div>
        </section>

        <section className="toolbar">
          <button type="button" onClick={generateSchedule} disabled={loading}>
            {loading ? "Generating..." : "Generate Schedule"}
          </button>
          <div className="status">{statusText}</div>
        </section>

        <section className="card">
          <h2>Schedule Timeline</h2>
          <div className="weekly-timeline">
            <div className="weekly-head">
              <div className="weekly-corner" />
              {calendarDays.map((day) => (
                <div key={day} className="weekly-day-head">{day.toUpperCase()}</div>
              ))}
            </div>

            <div className="weekly-body">
              <aside className="weekly-axis">
                {timelineMarks.map((minutes) => {
                  const topPct = ((minutes - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                  return (
                    <span key={minutes} style={{ top: `${topPct}%` }}>
                      {minutesToTime(minutes)}
                    </span>
                  );
                })}
              </aside>

              <div className="weekly-grid" style={{ gridTemplateColumns: `repeat(${calendarDays.length}, minmax(140px, 1fr))` }}>
                {calendarDays.map((day) => (
                  <div key={day} className="weekly-day-track">
                    {timelineMarks.map((minutes) => {
                      const topPct = ((minutes - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                      return <div key={`${day}_${minutes}`} className="weekly-line" style={{ top: `${topPct}%` }} />;
                    })}

                    {schedule
                      .filter((item) => item.day === day)
                      .filter((item) => {
                        if (!enableAlternatingWeeks || weekView === "both") {
                          return true;
                        }
                        return item.week_type === weekView;
                      })
                      .map((item) => {
                        const ts = timeslotById[item.timeslot_id];
                        const start = toMinutes(ts?.start_time);
                        const end = toMinutes(ts?.end_time);
                        if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER) {
                          return null;
                        }

                        const clampedStart = Math.max(DAY_START_MINUTES, start);
                        const clampedEnd = Math.min(DAY_END_MINUTES, end);
                        if (clampedEnd <= clampedStart) {
                          return null;
                        }

                        const topPct = ((clampedStart - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                        const heightPct = ((clampedEnd - clampedStart) / TIMELINE_TOTAL_MINUTES) * 100;
                        const classLabel = item.class_ids.map((id) => classNameById[id] ?? id).join(", ");

                        return (
                          <article
                            key={`${item.subject_id}_${item.timeslot_id}_${item.week_type ?? "base"}_${classLabel}`}
                            className={`weekly-event ${getSlotToneClass(ts)}`}
                            style={{ top: `${topPct}%`, height: `${Math.max(heightPct, 4)}%` }}
                          >
                            <strong>{item.subject_name}</strong>
                            {enableAlternatingWeeks && item.week_type ? <small>Week {item.week_type}</small> : null}
                            <small>{classLabel}</small>
                            <small>{ts?.start_time}-{ts?.end_time}</small>
                          </article>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </>
      )}
    </main>
  );
}
