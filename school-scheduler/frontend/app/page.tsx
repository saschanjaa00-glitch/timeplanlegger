"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Subject = {
  id: string;
  name: string;
  teacher_id: string;
  class_ids: string[];
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
    teacher_id: "",
    class_ids: [] as string[],
    assignment_mode: "per_class" as "per_class" | "shared",
    allowed_timeslots: "",
    allowed_block_ids: "",
  });
  const [teacherForm, setTeacherForm] = useState({ name: "", unavailable_timeslots: "" });
  const [classForm, setClassForm] = useState({ name: "" });
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
    class_ids: [] as string[],
  });
  const [activeWeekSetupId, setActiveWeekSetupId] = useState<string | null>(null);
  const [renamingWeekSetupId, setRenamingWeekSetupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
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
        setSubjects(parsed.subjects);
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

  const classNameById = useMemo(() => {
    return Object.fromEntries(classes.map((c) => [c.id, c.name])) as Record<string, string>;
  }, [classes]);

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
    setClassForm({ name: "" });
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

    const selectedClassIds = weekSetupForm.class_ids.filter((id) => classes.some((c) => c.id === id));

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
          class_ids: selectedClassIds,
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
        class_ids: selectedClassIds,
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
      class_ids: [...setup.class_ids],
    });

    setStatusText(`Applied week setup ${setup.name}.`);
  }

  function deleteWeekSetup(setupId: string) {
    setWeekCalendarSetups((prev) => prev.filter((setup) => setup.id !== setupId));
    if (activeWeekSetupId === setupId) {
      setActiveWeekSetupId(null);
      setWeekSetupForm({ name: "", class_ids: [] });
    }
    if (renamingWeekSetupId === setupId) {
      setRenamingWeekSetupId(null);
      setRenameDraft("");
    }
    setStatusText(`Deleted week setup ${setupId}.`);
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
      class_ids: [...source.class_ids],
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

  function addSubject() {
    if (!subjectForm.name || !subjectForm.class_ids.length) {
      return;
    }

    const allowedTimeslots = splitCsv(subjectForm.allowed_timeslots);
    const allowedBlocks = splitCsv(subjectForm.allowed_block_ids);

    setSubjects((prev) => {
      const existingIds = prev.map((s) => s.id);
      const toAdd: Subject[] = [];

      if (subjectForm.assignment_mode === "shared") {
        const id = makeUniqueId(`subject_${toSlug(subjectForm.name) || "item"}`, existingIds);
        const sharedSubject: Subject = {
          id,
          name: subjectForm.name,
          teacher_id: subjectForm.teacher_id,
          class_ids: subjectForm.class_ids,
        };
        if (allowedTimeslots.length) {
          sharedSubject.allowed_timeslots = allowedTimeslots;
        }
        if (allowedBlocks.length) {
          sharedSubject.allowed_block_ids = allowedBlocks;
        }
        toAdd.push(sharedSubject);
      } else {
        for (const classId of subjectForm.class_ids) {
          const base = `subject_${toSlug(subjectForm.name) || "item"}_${toSlug(classId)}`;
          const id = makeUniqueId(base, [...existingIds, ...toAdd.map((s) => s.id)]);
          const classSpecific: Subject = {
            id,
            name: subjectForm.name,
            teacher_id: subjectForm.teacher_id,
            class_ids: [classId],
          };
          if (allowedTimeslots.length) {
            classSpecific.allowed_timeslots = allowedTimeslots;
          }
          if (allowedBlocks.length) {
            classSpecific.allowed_block_ids = allowedBlocks;
          }
          toAdd.push(classSpecific);
        }
      }

      return [...prev, ...toAdd];
    });

    const createdCount = subjectForm.assignment_mode === "shared" ? 1 : subjectForm.class_ids.length;
    setStatusText(`Added ${createdCount} subject${createdCount > 1 ? "s" : ""}.`);

    setSubjectForm({
      name: "",
      teacher_id: "",
      class_ids: [],
      assignment_mode: "per_class",
      allowed_timeslots: "",
      allowed_block_ids: "",
    });
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

            <div className="calendar-field">
              <label>Classes For This Setup</label>
              <select
                multiple
                value={weekSetupForm.class_ids}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions).map((option) => option.value);
                  setWeekSetupForm((s) => ({ ...s, class_ids: selected }));
                }}
              >
                {classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {cls.name} ({cls.id})
                  </option>
                ))}
              </select>
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
                setWeekSetupForm({ name: "", class_ids: [] });
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
          <p>Add teaching groups like 1STA, 1STB, 1STC.</p>
          <form onSubmit={(e) => { e.preventDefault(); addClass(); }}>
            <label>Name</label>
            <input value={classForm.name} onChange={(e) => setClassForm((s) => ({ ...s, name: e.target.value }))} />
            <button type="submit">Add Class</button>
          </form>
          <div className="list">
            {classes.map((c) => (
              <div key={c.id} className="item">
                {c.id} - {c.name}
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
          <p>
            Fellesfag can be created once and cloned per class. Programfag can be shared across selected classes.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); addSubject(); }}>
            <label>Name</label>
            <input value={subjectForm.name} onChange={(e) => setSubjectForm((s) => ({ ...s, name: e.target.value }))} />
            <label>Teacher (optional)</label>
            <select
              value={subjectForm.teacher_id}
              onChange={(e) => setSubjectForm((s) => ({ ...s, teacher_id: e.target.value }))}
            >
              <option value="">No teacher yet</option>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.name} ({teacher.id})
                </option>
              ))}
            </select>
            <label>Classes</label>
            <select
              multiple
              value={subjectForm.class_ids}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions).map((option) => option.value);
                setSubjectForm((s) => ({ ...s, class_ids: selected }));
              }}
            >
              {classes.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {cls.name} ({cls.id})
                </option>
              ))}
            </select>
            <label>Subject Type</label>
            <select
              value={subjectForm.assignment_mode}
              onChange={(e) => {
                const mode = e.target.value as "per_class" | "shared";
                setSubjectForm((s) => ({ ...s, assignment_mode: mode }));
              }}
            >
              <option value="per_class">Fellesfag (one per selected class)</option>
              <option value="shared">Programfag (shared across selected classes)</option>
            </select>
            <label>Allowed Timeslot IDs (optional, comma-separated)</label>
            <input
              value={subjectForm.allowed_timeslots}
              onChange={(e) => setSubjectForm((s) => ({ ...s, allowed_timeslots: e.target.value }))}
            />
            <label>Allowed Block IDs (optional, comma-separated)</label>
            <input
              value={subjectForm.allowed_block_ids}
              onChange={(e) => setSubjectForm((s) => ({ ...s, allowed_block_ids: e.target.value }))}
            />
            <button type="submit">Add Subject</button>
          </form>

          <div className="list">
            {subjects.map((s) => (
              <div key={s.id} className="item">
                {s.id} - {s.name} | teacher: {s.teacher_id || "none"} | classes: {s.class_ids.join(", ")}
              </div>
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
              {classes.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {cls.name} ({cls.id})
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
