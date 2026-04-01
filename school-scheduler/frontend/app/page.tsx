"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type Subject = {
  id: string;
  name: string;
  teacher_id: string;
  teacher_ids: string[];
  class_ids: string[];
  subject_type: "fellesfag" | "programfag";
  sessions_per_week: number;
  // alternating_week_split is DISABLED - auto-balancing is used instead
  force_place?: boolean;
  force_timeslot_id?: string;
  allowed_timeslots?: string[];
  allowed_block_ids?: string[];
};

type Teacher = {
  id: string;
  name: string;
  avdeling?: string;
  preferred_avoid_timeslots: string[];
  unavailable_timeslots: string[];
  workload_percent: number;
};

type MeetingTeacherAssignment = {
  teacher_id: string;
  mode: "preferred" | "unavailable";
};

type Meeting = {
  id: string;
  name: string;
  timeslot_id: string;
  teacher_assignments: MeetingTeacherAssignment[];
};

type SchoolClass = {
  id: string;
  name: string;
  base_room_id?: string;
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
  excluded_from_generation?: boolean;
  generation_allowed_class_ids?: string[];
};

type BlockOccurrence = {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  week_type: "A" | "B" | "both";
};

type BlockSubjectEntry = {
  subject_id: string;
  teacher_id: string;
  preferred_room_id: string;
};

type Block = {
  id: string;
  name: string;
  occurrences: BlockOccurrence[];
  class_ids: string[];
  subject_entries: BlockSubjectEntry[];
  // Legacy fields kept for backwards compatibility
  timeslot_ids?: string[];
  week_pattern?: "both" | "A" | "B";
  a_week_lessons?: number;
  b_week_lessons?: number;
  subject_ids?: string[];
};

type Room = {
  id: string;
  name: string;
};

type TabKey = "calendar" | "classes" | "subjects" | "faggrupper" | "blocks" | "meetings" | "rom" | "teachers" | "generate";

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

type MeetingFormState = {
  name: string;
  timeslot_id: string;
  teacher_modes: Record<string, "preferred" | "unavailable">;
};

type ScheduledItem = {
  subject_id: string;
  subject_name: string;
  teacher_id: string;
  teacher_ids?: string[];
  class_ids: string[];
  timeslot_id: string;
  day: string;
  period: number;
  start_time?: string;
  end_time?: string;
  week_type?: "A" | "B";
  room_id?: string;
};

type GenerateResponse = {
  status: string;
  message: string;
  schedule: ScheduledItem[];
  metadata?: Record<string, number>;
};

function mergeScheduleForDisplay(items: ScheduledItem[]): ScheduledItem[] {
  type PairBucket = { shared: ScheduledItem[]; a: ScheduledItem[]; b: ScheduledItem[] };
  const buckets = new Map<string, PairBucket>();

  for (const item of items) {
    const classKey = [...item.class_ids].sort().join(",");
    const key = [item.subject_id, item.teacher_id, item.timeslot_id, item.day, String(item.period), classKey].join("|");
    const bucket = buckets.get(key) ?? { shared: [], a: [], b: [] };
    if (item.week_type === "A") {
      bucket.a.push(item);
    } else if (item.week_type === "B") {
      bucket.b.push(item);
    } else {
      bucket.shared.push(item);
    }
    buckets.set(key, bucket);
  }

  const merged: ScheduledItem[] = [];
  buckets.forEach((bucket) => {
    if (bucket.shared.length > 0) {
      merged.push(...bucket.shared);
    }

    const pairCount = Math.min(bucket.a.length, bucket.b.length);
    for (let i = 0; i < pairCount; i += 1) {
      merged.push({ ...bucket.a[i], week_type: undefined });
    }

    if (bucket.a.length > pairCount) {
      merged.push(...bucket.a.slice(pairCount));
    }
    if (bucket.b.length > pairCount) {
      merged.push(...bucket.b.slice(pairCount));
    }
  });

  return merged.sort((a, b) => {
    const weekA = a.week_type ?? "";
    const weekB = b.week_type ?? "";
    if (weekA !== weekB) {
      return weekA.localeCompare(weekB);
    }
    const dayCmp = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
    if (dayCmp !== 0) {
      return dayCmp;
    }
    if (a.period !== b.period) {
      return a.period - b.period;
    }
    return a.subject_name.localeCompare(b.subject_name);
  });
}

function formatGeneratedScheduleStatus(data: GenerateResponse, runId: number): string {
  const schedule = data.schedule || [];
  const countA = schedule.filter((item) => item.week_type === "A").length;
  const countB = schedule.filter((item) => item.week_type === "B").length;
  const countShared = schedule.length - countA - countB;
  const mergedCount = mergeScheduleForDisplay(schedule).length;

  if (countA === 0 && countB === 0) {
    return `${data.message} ${schedule.length} item(s) generated (run ${runId}).`;
  }

  const hasWeekSpecificPlacements = mergedCount !== schedule.length;
  const filterHint = hasWeekSpecificPlacements
    ? " Switch week filter to A or B to inspect week-specific placements."
    : "";

  return `${data.message} ${schedule.length} raw item(s): ${countShared} shared, ${countA} A, ${countB} B; combined view shows ${mergedCount} item(s) (run ${runId}).${filterHint}`;
}

type CompareEntity = {
  id: string;
  label: string;
  kind: "class" | "teacher" | "room";
  color: string;
};

const API_BASE = "http://127.0.0.1:8000";

const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const calendarDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_START_MINUTES = 8 * 60;
const DAY_END_MINUTES = 16 * 60;
const TIMELINE_TOTAL_MINUTES = DAY_END_MINUTES - DAY_START_MINUTES;
const STORAGE_KEY = "school_scheduler_state_v3";
const LEGACY_STORAGE_KEYS = ["school_scheduler_state_v2", "school_scheduler_state_v1"];
const COMPARE_PALETTE = [
  "#e76f51",
  "#2a9d8f",
  "#457b9d",
  "#f4a261",
  "#8d5a97",
  "#4f772d",
  "#c44536",
  "#3d5a80",
  "#2d6a4f",
  "#6d597a",
];

const workflowTabs: Array<{ id: TabKey; label: string }> = [
  { id: "calendar", label: "Week Calendar" },
  { id: "classes", label: "Classes" },
  { id: "subjects", label: "Subjects" },
  { id: "faggrupper", label: "Fellesfag" },
  { id: "blocks", label: "Blocks" },
  { id: "meetings", label: "Møter" },
  { id: "rom", label: "Rom" },
  { id: "teachers", label: "Teachers" },
  { id: "generate", label: "Generate" },
];

function parseWeekView(value: unknown): WeekView {
  return value === "A" || value === "B" ? value : "both";
}

function normalizeBlock(block: Partial<Block>): Block {
  const normalizedOccurrences = Array.isArray(block.occurrences)
    ? block.occurrences.map((o, i): BlockOccurrence => ({
        id: o.id || `occ_${i + 1}`,
        day: o.day || "Monday",
        start_time: o.start_time || "08:20",
        end_time: o.end_time || "09:50",
        week_type: o.week_type === "A" || o.week_type === "B" ? o.week_type : "both",
      }))
    : [];
  const hasOccurrences = normalizedOccurrences.length > 0;

  return {
    id: block.id ?? "",
    name: block.name ?? "",
    occurrences: normalizedOccurrences,
    class_ids: Array.isArray(block.class_ids) ? block.class_ids : [],
    subject_entries: Array.isArray(block.subject_entries)
      ? block.subject_entries.map((se) => ({
          subject_id: se.subject_id ?? "",
          teacher_id: se.teacher_id ?? "",
          preferred_room_id: se.preferred_room_id ?? "",
        }))
      : [],
    // Legacy fields
    timeslot_ids: hasOccurrences ? [] : (Array.isArray(block.timeslot_ids) ? block.timeslot_ids : []),
    week_pattern: hasOccurrences
      ? "both"
      : (block.week_pattern === "A" || block.week_pattern === "B" ? block.week_pattern : "both"),
    a_week_lessons: typeof block.a_week_lessons === "number" ? block.a_week_lessons : 5,
    b_week_lessons: typeof block.b_week_lessons === "number" ? block.b_week_lessons : 5,
    subject_ids: Array.isArray(block.subject_ids) ? block.subject_ids : [],
  };
}

function normalizeTimeslot(timeslot: Partial<Timeslot>): Timeslot {
  return {
    id: timeslot.id ?? "",
    day: timeslot.day ?? "Monday",
    period: typeof timeslot.period === "number" ? timeslot.period : 1,
    start_time: timeslot.start_time,
    end_time: timeslot.end_time,
    is_double: Boolean(timeslot.is_double),
    is_idrett: Boolean(timeslot.is_idrett),
    is_lunch: Boolean(timeslot.is_lunch),
    excluded_from_generation: Boolean(timeslot.excluded_from_generation),
    generation_allowed_class_ids: Array.isArray(timeslot.generation_allowed_class_ids)
      ? timeslot.generation_allowed_class_ids.filter(Boolean)
      : [],
  };
}

function normalizeSubject(subject: Partial<Subject>): Subject {
  const normalizedTeacherIds = Array.isArray(subject.teacher_ids)
    ? subject.teacher_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const fallbackTeacherId = typeof subject.teacher_id === "string" ? subject.teacher_id.trim() : "";
  const teacherIds = Array.from(new Set([
    ...(fallbackTeacherId ? [fallbackTeacherId] : []),
    ...normalizedTeacherIds,
  ]));
  return {
    id: subject.id ?? "",
    name: subject.name ?? "",
    teacher_id: teacherIds[0] ?? "",
    teacher_ids: teacherIds,
    class_ids: Array.isArray(subject.class_ids) ? subject.class_ids : [],
    subject_type: subject.subject_type === "programfag" ? "programfag" : "fellesfag",
    sessions_per_week:
      typeof subject.sessions_per_week === "number" && subject.sessions_per_week > 0
        ? Math.floor(subject.sessions_per_week)
        : 1,
    force_place: Boolean(subject.force_place),
    force_timeslot_id:
      typeof subject.force_timeslot_id === "string" && subject.force_timeslot_id.trim()
        ? subject.force_timeslot_id.trim()
        : undefined,
    // alternating_week_split is DISABLED
    allowed_timeslots: Array.isArray(subject.allowed_timeslots) ? subject.allowed_timeslots : undefined,
    allowed_block_ids: Array.isArray(subject.allowed_block_ids) ? subject.allowed_block_ids : undefined,
  };
}

function normalizeTeacher(teacher: Partial<Teacher>): Teacher {
  const rawWorkload =
    typeof teacher.workload_percent === "number"
      ? teacher.workload_percent
      : 100;
  const workloadPercent = Math.min(100, Math.max(1, Math.round(rawWorkload)));

  return {
    id: teacher.id ?? "",
    name: teacher.name ?? "",
    avdeling: typeof teacher.avdeling === "string" ? teacher.avdeling.trim() : "",
    preferred_avoid_timeslots: Array.isArray(teacher.preferred_avoid_timeslots)
      ? teacher.preferred_avoid_timeslots
      : [],
    unavailable_timeslots: Array.isArray(teacher.unavailable_timeslots)
      ? teacher.unavailable_timeslots
      : [],
    workload_percent: workloadPercent,
  };
}

function normalizeMeeting(meeting: Partial<Meeting>): Meeting {
  const assignments = Array.isArray(meeting.teacher_assignments)
    ? meeting.teacher_assignments
        .filter(
          (assignment): assignment is MeetingTeacherAssignment =>
            Boolean(assignment?.teacher_id) &&
            (assignment?.mode === "preferred" || assignment?.mode === "unavailable")
        )
        .map((assignment) => ({
          teacher_id: assignment.teacher_id,
          mode: assignment.mode,
        }))
    : [];

  return {
    id: meeting.id ?? "",
    name: meeting.name ?? "",
    timeslot_id: meeting.timeslot_id ?? "",
    teacher_assignments: assignments,
  };
}

function splitCsv(input: string): string[] {
  return input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractAvdeling(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const tokens = value
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[.,;:]+$/g, ""))
    .filter(Boolean);

  return tokens.at(-1) ?? "";
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[åÅ]/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFuzzyTokenMatch(queryToken: string, candidateToken: string): boolean {
  if (!queryToken || !candidateToken) {
    return false;
  }

  if (candidateToken.includes(queryToken)) {
    return true;
  }

  return false;
}

function isTeacherNameMatch(query: string, teacherName: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const nameTokens = normalizeSearchText(teacherName).split(" ").filter(Boolean);
  if (!queryTokens.length || !nameTokens.length) {
    return false;
  }

  const allQueryTokensMatch = queryTokens.every((queryToken) =>
    nameTokens.some((nameToken) => isFuzzyTokenMatch(queryToken, nameToken))
  );
  if (allQueryTokensMatch) {
    return true;
  }

  const collapsedQuery = queryTokens.join(" ");
  const collapsedName = nameTokens.join(" ");
  return isFuzzyTokenMatch(collapsedQuery, collapsedName) || collapsedName.includes(collapsedQuery);
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
  const trimmed = value.trim().replace(/[;.,]/g, ":");

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

function isValidTime24(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalizeTime24(value));
}

function minutesToTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDurationMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.floor(totalMinutes));
  const h = Math.floor(safeMinutes / 60);
  const m = safeMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
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

function toOpaqueTint(hexColor: string, mixWithWhite = 0.82): string {
  const hex = hexColor.trim().replace(/^#/, "");
  const normalized = hex.length === 3
    ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return "#efe9df";
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);

  const alpha = Math.min(1, Math.max(0, mixWithWhite));
  const mixedR = Math.round(r * (1 - alpha) + 255 * alpha);
  const mixedG = Math.round(g * (1 - alpha) + 255 * alpha);
  const mixedB = Math.round(b * (1 - alpha) + 255 * alpha);
  return `rgb(${mixedR}, ${mixedG}, ${mixedB})`;
}

function toRgbTuple(color: string): [number, number, number] | null {
  const text = color.trim();
  const hex = text.replace(/^#/, "");
  const normalizedHex = hex.length === 3
    ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : hex;

  if (/^[0-9a-fA-F]{6}$/.test(normalizedHex)) {
    return [
      Number.parseInt(normalizedHex.slice(0, 2), 16),
      Number.parseInt(normalizedHex.slice(2, 4), 16),
      Number.parseInt(normalizedHex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = text.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return [
      Math.max(0, Math.min(255, Number.parseInt(rgbMatch[1], 10))),
      Math.max(0, Math.min(255, Number.parseInt(rgbMatch[2], 10))),
      Math.max(0, Math.min(255, Number.parseInt(rgbMatch[3], 10))),
    ];
  }

  return null;
}

function weekStripeOverlayForColor(baseColor: string, direction: "up" | "down"): string {
  const rgb = toRgbTuple(baseColor) ?? [210, 210, 210];
  const darkenFactor = 0.72;
  const stripeR = Math.round(rgb[0] * darkenFactor);
  const stripeG = Math.round(rgb[1] * darkenFactor);
  const stripeB = Math.round(rgb[2] * darkenFactor);
  const angle = direction === "up" ? "45deg" : "-45deg";
  return `repeating-linear-gradient(${angle}, rgba(${stripeR}, ${stripeG}, ${stripeB}, 0.18) 0, rgba(${stripeR}, ${stripeG}, ${stripeB}, 0.18) 1px, rgba(255, 255, 255, 0) 1px, rgba(255, 255, 255, 0) 16px)`;
}

function darkenColor(color: string, amount = 0.04): string {
  const rgb = toRgbTuple(color);
  if (!rgb) {
    return color;
  }

  // Keep hue, lower lightness a bit, and bump saturation slightly
  // so block cards feel richer instead of grayer.
  const rN = rgb[0] / 255;
  const gN = rgb[1] / 255;
  const bN = rgb[2] / 255;
  const cMax = Math.max(rN, gN, bN);
  const cMin = Math.min(rN, gN, bN);
  const delta = cMax - cMin;

  let h = 0;
  if (delta !== 0) {
    if (cMax === rN) {
      h = ((gN - bN) / delta) % 6;
    } else if (cMax === gN) {
      h = (bN - rN) / delta + 2;
    } else {
      h = (rN - gN) / delta + 4;
    }
  }
  h = (h * 60 + 360) % 360;
  const l = (cMax + cMin) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  const safeAmount = Math.max(0, Math.min(0.2, amount));
  const adjustedL = Math.max(0, Math.min(1, l - safeAmount));
  const adjustedS = Math.max(0, Math.min(1, s + 0.05));

  const c = (1 - Math.abs(2 * adjustedL - 1)) * adjustedS;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = adjustedL - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return `rgb(${r}, ${g}, ${b})`;
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
        generation_allowed_class_ids: slot.generation_allowed_class_ids ?? [],
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
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [timeslots, setTimeslots] = useState<Timeslot[]>([]);
  const [weekCalendarSetups, setWeekCalendarSetups] = useState<WeekCalendarSetup[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [schedule, setSchedule] = useState<ScheduledItem[]>([]);
  const [statusText, setStatusText] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("calendar");
  const enableAlternatingWeeks = true;
  const [weekView, setWeekView] = useState<WeekView>("both");
  const alternateNonBlockSubjects = true;

  const [subjectForm, setSubjectForm] = useState({
    name: "",
  });
  const [teacherForm, setTeacherForm] = useState({ name: "", unavailable_timeslots: "", workload_percent: "100" });
  const [meetingForm, setMeetingForm] = useState<MeetingFormState>({
    name: "",
    timeslot_id: "",
    teacher_modes: {},
  });
  const [editingMeetingId, setEditingMeetingId] = useState<string | null>(null);
  const [expandedMeetings, setExpandedMeetings] = useState<Set<string>>(new Set());
  const [meetingTeacherSearchQuery, setMeetingTeacherSearchQuery] = useState("");
  const [meetingAvdelingFilter, setMeetingAvdelingFilter] = useState("all");
  const [roomForm, setRoomForm] = useState({ name: "" });
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [teacherSearchQuery, setTeacherSearchQuery] = useState("");
  const [teacherSearchBySubjectEntity, setTeacherSearchBySubjectEntity] = useState<Record<string, string>>({});
  const [subjectClassSelectionBySubject, setSubjectClassSelectionBySubject] = useState<Record<string, string>>({});
  const [selectedClassCompareIds, setSelectedClassCompareIds] = useState<string[]>([]);
  const [selectedTeacherCompareIds, setSelectedTeacherCompareIds] = useState<string[]>([]);
  const [selectedRoomCompareIds, setSelectedRoomCompareIds] = useState<string[]>([]);
  const [compareClassSearchQuery, setCompareClassSearchQuery] = useState("");
  const [compareTeacherSearchQuery, setCompareTeacherSearchQuery] = useState("");
  const [compareRoomSearchQuery, setCompareRoomSearchQuery] = useState("");
  const [teacherOnSiteSearchQuery, setTeacherOnSiteSearchQuery] = useState("");
  const [teacherOnSiteCollapsed, setTeacherOnSiteCollapsed] = useState(false);
  const [teacherOnSiteSortMode, setTeacherOnSiteSortMode] = useState<"name" | "time">("name");
  const [showUltrawideTimeline, setShowUltrawideTimeline] = useState(true);
  const [hoveredTimelineEventKey, setHoveredTimelineEventKey] = useState<string | null>(null);
  const [hoveredTimelineSubjectId, setHoveredTimelineSubjectId] = useState<string | null>(null);
  const [expandedTimelineEventKey, setExpandedTimelineEventKey] = useState<string | null>(null);
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
    excluded_from_generation: false,
    generation_allowed_class_ids: [] as string[],
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
  const [activeFaggruppeClassId, setActiveFaggruppeClassId] = useState<string | null>(null);
  const [faggrupperClassSearchQuery, setFaggrupperClassSearchQuery] = useState("");
  const [expandedSubjectId, setExpandedSubjectId] = useState<string | null>(null);
  const [fellesfagSelectionByClass, setFellesfagSelectionByClass] = useState<Record<string, string>>({});
  const [duplicateTargetsByClass, setDuplicateTargetsByClass] = useState<Record<string, string[]>>({});
  const [blockForm, setBlockForm] = useState<{
    name: string;
    occurrences: BlockOccurrence[];
    class_ids: string[];
    subject_entries: BlockSubjectEntry[];
  }>({
    name: "",
    occurrences: [],
    class_ids: [],
    subject_entries: [],
  });
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [blockOccForm, setBlockOccForm] = useState({
    day: "Monday",
    start_time: "08:20",
    end_time: "09:50",
    week_type: "both" as WeekView,
  });
  const [blockSubjForm, setBlockSubjForm] = useState({
    subject_id: "",
    teacher_id: "",
    preferred_room_id: "",
    new_subject_name: "",
  });
  const [isStorageHydrated, setIsStorageHydrated] = useState(false);
  const [expandedTeacherId, setExpandedTeacherId] = useState<string | null>(null);
  const [expandedBlockId, setExpandedBlockId] = useState<string | null>(null);
  const [blockInlineSubjNames, setBlockInlineSubjNames] = useState<Record<string, string>>({});
  const excelFileRef = useRef<HTMLInputElement>(null);
  const generationRunRef = useRef(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const source = raw ?? LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);

      if (!source) {
        setIsStorageHydrated(true);
        return;
      }

      const parsed = JSON.parse(source) as Partial<{
        subjects: Subject[];
        teachers: Teacher[];
        meetings: Meeting[];
        rooms: Room[];
        classes: SchoolClass[];
        timeslots: Timeslot[];
        weekCalendarSetups: WeekCalendarSetup[];
        blocks: Block[];
        schedule: ScheduledItem[];
        activeCalendarDay: string;
        activeTab: TabKey;
        activeWeekSetupId: string | null;
        weekView: WeekView;
      }>;

      if (Array.isArray(parsed.subjects)) {
        setSubjects(parsed.subjects.map((subject) => normalizeSubject(subject)));
      }
      if (Array.isArray(parsed.teachers)) {
        setTeachers(parsed.teachers.map((teacher) => normalizeTeacher(teacher)));
      }
      if (Array.isArray(parsed.meetings)) {
        setMeetings(parsed.meetings.map((meeting) => normalizeMeeting(meeting)));
      }
      if (Array.isArray(parsed.rooms)) {
        setRooms(parsed.rooms);
      }
      if (Array.isArray(parsed.classes)) {
        setClasses(parsed.classes);
      }
      if (Array.isArray(parsed.timeslots)) {
        setTimeslots(parsed.timeslots.map((timeslot) => normalizeTimeslot(timeslot)));
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
      meetings,
      rooms,
      classes,
      timeslots,
      weekCalendarSetups,
      blocks,
      schedule,
      activeCalendarDay,
      activeTab,
      activeWeekSetupId,
      weekView,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    isStorageHydrated,
    subjects,
    teachers,
    meetings,
    rooms,
    classes,
    timeslots,
    weekCalendarSetups,
    blocks,
    schedule,
    activeCalendarDay,
    activeTab,
    activeWeekSetupId,
    weekView,
  ]);

  useEffect(() => {
    if (!isStorageHydrated) {
      return;
    }
    setBlocks((prev) => prev.map((block) => normalizeBlock(block)));
  }, [isStorageHydrated]);

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

  const sortedMeetings = useMemo(() => {
    return [...meetings].sort((a, b) => {
      const slotA = timeslotById[a.timeslot_id];
      const slotB = timeslotById[b.timeslot_id];
      const dayCmp = dayOrder.indexOf(slotA?.day ?? "") - dayOrder.indexOf(slotB?.day ?? "");
      if (dayCmp !== 0) {
        return dayCmp;
      }
      const timeCmp = toMinutes(slotA?.start_time) - toMinutes(slotB?.start_time);
      if (timeCmp !== 0) {
        return timeCmp;
      }
      return a.name.localeCompare(b.name);
    });
  }, [meetings, timeslotById]);

  const sortedClasses = useMemo(() => {
    return [...classes].sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);

  const sortedRooms = useMemo(() => {
    return [...rooms].sort((a, b) => a.name.localeCompare(b.name));
  }, [rooms]);

  const filteredCompareClasses = useMemo(() => {
    const q = compareClassSearchQuery.trim().toLowerCase();
    if (!q) {
      return sortedClasses;
    }
    return sortedClasses.filter((schoolClass) =>
      schoolClass.name.toLowerCase().includes(q) || schoolClass.id.toLowerCase().includes(q)
    );
  }, [sortedClasses, compareClassSearchQuery]);

  const filteredCompareRooms = useMemo(() => {
    const q = compareRoomSearchQuery.trim().toLowerCase();
    if (!q) {
      return sortedRooms;
    }
    return sortedRooms.filter((room) =>
      room.name.toLowerCase().includes(q) || room.id.toLowerCase().includes(q)
    );
  }, [sortedRooms, compareRoomSearchQuery]);

  const roomsAssignedToClasses = useMemo(() => {
    return new Set(classes.map((c) => c.base_room_id).filter((id): id is string => !!id));
  }, [classes]);

  const sortedTeachersByFirstName = useMemo(() => {
    return [...teachers].sort((a, b) => {
      const aFirstName = a.name.trim().split(/\s+/)[0] ?? "";
      const bFirstName = b.name.trim().split(/\s+/)[0] ?? "";
      return aFirstName.localeCompare(bFirstName, undefined, { sensitivity: "base" });
    });
  }, [teachers]);

  const filteredCompareTeachers = useMemo(() => {
    const q = compareTeacherSearchQuery.trim();
    if (!q) {
      return sortedTeachersByFirstName;
    }
    return sortedTeachersByFirstName.filter((teacher) =>
      isTeacherNameMatch(q, teacher.name) || teacher.id.toLowerCase().includes(q.toLowerCase())
    );
  }, [sortedTeachersByFirstName, compareTeacherSearchQuery]);

  const teacherOnSiteSummaries = useMemo(() => {
    const weekLabels = enableAlternatingWeeks ? (["A", "B"] as const) : (["A"] as const);
    const summaryByTeacher = new Map<string, {
      aMinutes: number;
      bMinutes: number;
      averageMinutes: number;
      aText: string;
      bText: string;
      averageText: string;
    }>();

    const addSpanForDay = (
      teacherId: string,
      weekLabel: "A" | "B",
      day: string,
      startMin: number,
      endMin: number,
      bucket: Map<string, Map<string, { start: number; end: number }>>,
    ) => {
      if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
        return;
      }
      if (!bucket.has(teacherId)) {
        bucket.set(teacherId, new Map());
      }
      const dayKey = `${weekLabel}_${day}`;
      const teacherDays = bucket.get(teacherId)!;
      const existing = teacherDays.get(dayKey);
      if (!existing) {
        teacherDays.set(dayKey, { start: startMin, end: endMin });
        return;
      }
      existing.start = Math.min(existing.start, startMin);
      existing.end = Math.max(existing.end, endMin);
    };

    const dayWindowsByTeacher = new Map<string, Map<string, { start: number; end: number }>>();

    for (const item of schedule) {
      const ts = timeslotById[item.timeslot_id];
      if (!ts) {
        continue;
      }
      const startMin = toMinutes(item.start_time ?? ts.start_time);
      const endMin = toMinutes(item.end_time ?? ts.end_time);
      if (startMin === Number.MAX_SAFE_INTEGER || endMin === Number.MAX_SAFE_INTEGER) {
        continue;
      }

      if (!enableAlternatingWeeks || !item.week_type) {
        for (const weekLabel of weekLabels) {
          addSpanForDay(item.teacher_id, weekLabel, ts.day, startMin, endMin, dayWindowsByTeacher);
        }
      } else {
        addSpanForDay(item.teacher_id, item.week_type, ts.day, startMin, endMin, dayWindowsByTeacher);
      }
    }

    // Count preferred meetings as fixed teacher presence to mirror solver workload span logic.
    for (const meeting of meetings) {
      const ts = timeslotById[meeting.timeslot_id];
      if (!ts) {
        continue;
      }
      const startMin = toMinutes(ts.start_time);
      const endMin = toMinutes(ts.end_time);
      if (startMin === Number.MAX_SAFE_INTEGER || endMin === Number.MAX_SAFE_INTEGER) {
        continue;
      }

      for (const assignment of meeting.teacher_assignments) {
        if (assignment.mode !== "preferred") {
          continue;
        }
        for (const weekLabel of weekLabels) {
          addSpanForDay(assignment.teacher_id, weekLabel, ts.day, startMin, endMin, dayWindowsByTeacher);
        }
      }
    }

    for (const teacher of sortedTeachersByFirstName) {
      const teacherDays = dayWindowsByTeacher.get(teacher.id);
      let aMinutes = 0;
      let bMinutes = 0;

      if (teacherDays) {
        for (const [dayKey, span] of teacherDays.entries()) {
          const duration = Math.max(0, span.end - span.start);
          if (dayKey.startsWith("A_")) {
            aMinutes += duration;
          } else if (dayKey.startsWith("B_")) {
            bMinutes += duration;
          }
        }
      }

      const averageMinutes = enableAlternatingWeeks
        ? Math.round((aMinutes + bMinutes) / 2)
        : aMinutes;

      summaryByTeacher.set(teacher.id, {
        aMinutes,
        bMinutes,
        averageMinutes,
        aText: formatDurationMinutes(aMinutes),
        bText: formatDurationMinutes(bMinutes),
        averageText: formatDurationMinutes(averageMinutes),
      });
    }

    return sortedTeachersByFirstName.map((teacher) => ({
      teacher,
      totals: summaryByTeacher.get(teacher.id) ?? {
        aMinutes: 0,
        bMinutes: 0,
        averageMinutes: 0,
        aText: formatDurationMinutes(0),
        bText: formatDurationMinutes(0),
        averageText: formatDurationMinutes(0),
      },
    }));
  }, [enableAlternatingWeeks, meetings, schedule, sortedTeachersByFirstName, timeslotById]);

  const filteredTeacherOnSiteSummaries = useMemo(() => {
    const q = teacherOnSiteSearchQuery.trim();
    if (!q) {
      return teacherOnSiteSummaries;
    }
    return teacherOnSiteSummaries.filter(({ teacher }) => (
      isTeacherNameMatch(q, teacher.name) || teacher.id.toLowerCase().includes(q.toLowerCase())
    ));
  }, [teacherOnSiteSearchQuery, teacherOnSiteSummaries]);

  const sortedFilteredTeacherOnSiteSummaries = useMemo(() => {
    const sorted = [...filteredTeacherOnSiteSummaries];
    if (teacherOnSiteSortMode === "time") {
      sorted.sort((a, b) => {
        const aMinutes = enableAlternatingWeeks ? a.totals.averageMinutes : a.totals.aMinutes;
        const bMinutes = enableAlternatingWeeks ? b.totals.averageMinutes : b.totals.aMinutes;
        if (bMinutes !== aMinutes) {
          return bMinutes - aMinutes;
        }
        return a.teacher.name.localeCompare(b.teacher.name);
      });
      return sorted;
    }
    sorted.sort((a, b) => a.teacher.name.localeCompare(b.teacher.name));
    return sorted;
  }, [enableAlternatingWeeks, filteredTeacherOnSiteSummaries, teacherOnSiteSortMode]);

  const filteredTeachers = useMemo(() => {
    return sortedTeachersByFirstName.filter((teacher) => isTeacherNameMatch(teacherSearchQuery, teacher.name));
  }, [sortedTeachersByFirstName, teacherSearchQuery]);

  const availableAvdelinger = useMemo(() => {
    return Array.from(
      new Set(
        teachers
          .map((teacher) => teacher.avdeling?.trim() ?? "")
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [teachers]);

  const filteredMeetingTeachers = useMemo(() => {
    return sortedTeachersByFirstName.filter((teacher) => {
      const matchesName = isTeacherNameMatch(meetingTeacherSearchQuery, teacher.name);
      const matchesAvdeling = meetingAvdelingFilter === "all"
        ? true
        : (teacher.avdeling?.trim() ?? "") === meetingAvdelingFilter;
      return matchesName && matchesAvdeling;
    });
  }, [sortedTeachersByFirstName, meetingTeacherSearchQuery, meetingAvdelingFilter]);

  function filterTeachersForQuery(query: string): Teacher[] {
    return sortedTeachersByFirstName.filter((teacher) => isTeacherNameMatch(query, teacher.name));
  }

  function resetMeetingForm() {
    setMeetingForm({
      name: "",
      timeslot_id: sortedTimeslots[0]?.id ?? "",
      teacher_modes: {},
    });
    setEditingMeetingId(null);
    setMeetingTeacherSearchQuery("");
  }

  function cycleMeetingTeacherMode(teacherId: string) {
    setMeetingForm((prev) => {
      const nextModes = { ...prev.teacher_modes };
      const current = nextModes[teacherId];

      if (current === "preferred") {
        nextModes[teacherId] = "unavailable";
      } else if (current === "unavailable") {
        delete nextModes[teacherId];
      } else {
        nextModes[teacherId] = "preferred";
      }

      return {
        ...prev,
        teacher_modes: nextModes,
      };
    });
  }

  function applyMeetingTeacherModeToVisible(mode: "preferred" | "unavailable" | null) {
    setMeetingForm((prev) => {
      const nextModes = { ...prev.teacher_modes };

      for (const teacher of filteredMeetingTeachers) {
        if (mode === null) {
          delete nextModes[teacher.id];
        } else {
          nextModes[teacher.id] = mode;
        }
      }

      return {
        ...prev,
        teacher_modes: nextModes,
      };
    });

    if (mode === "unavailable") {
      setStatusText(`Marked ${filteredMeetingTeachers.length} visible teacher(s) as busy.`);
      return;
    }
    if (mode === "preferred") {
      setStatusText(`Marked ${filteredMeetingTeachers.length} visible teacher(s) as prefer busy.`);
      return;
    }
    setStatusText(`Cleared meeting selection for ${filteredMeetingTeachers.length} visible teacher(s).`);
  }

  function loadMeetingIntoForm(meeting: Meeting) {
    setEditingMeetingId(meeting.id);
    setMeetingForm({
      name: meeting.name,
      timeslot_id: meeting.timeslot_id,
      teacher_modes: Object.fromEntries(
        meeting.teacher_assignments.map((assignment) => [assignment.teacher_id, assignment.mode])
      ) as Record<string, "preferred" | "unavailable">,
    });
    setStatusText(`Editing meeting ${meeting.name}.`);
  }

  function upsertMeeting() {
    const name = meetingForm.name.trim();
    const timeslotId = meetingForm.timeslot_id;
    const teacherAssignments = Object.entries(meetingForm.teacher_modes)
      .filter((entry): entry is [string, "preferred" | "unavailable"] => entry[1] === "preferred" || entry[1] === "unavailable")
      .filter(([teacherId]) => teachers.some((teacher) => teacher.id === teacherId))
      .map(([teacher_id, mode]) => ({ teacher_id, mode }));

    if (!name) {
      setStatusText("Meeting name is required.");
      return;
    }
    if (!timeslotId || !timeslots.some((slot) => slot.id === timeslotId)) {
      setStatusText("Select a valid timeslot for the meeting.");
      return;
    }
    if (teacherAssignments.length === 0) {
      setStatusText("Pick at least one teacher as preferred or blocked for the meeting.");
      return;
    }

    if (editingMeetingId) {
      setMeetings((prev) => prev.map((meeting) => (
        meeting.id === editingMeetingId
          ? {
              ...meeting,
              name,
              timeslot_id: timeslotId,
              teacher_assignments: teacherAssignments,
            }
          : meeting
      )));
      setStatusText(`Updated meeting ${name}.`);
      resetMeetingForm();
      return;
    }

    const id = makeUniqueId(`meeting_${toSlug(name) || "item"}`, meetings.map((meeting) => meeting.id));
    setMeetings((prev) => [
      ...prev,
      {
        id,
        name,
        timeslot_id: timeslotId,
        teacher_assignments: teacherAssignments,
      },
    ]);
    setStatusText(`Added meeting ${name}.`);
    resetMeetingForm();
  }

  function deleteMeeting(meetingId: string) {
    const meetingName = meetings.find((meeting) => meeting.id === meetingId)?.name ?? meetingId;
    setMeetings((prev) => prev.filter((meeting) => meeting.id !== meetingId));
    if (editingMeetingId === meetingId) {
      resetMeetingForm();
    }
    setStatusText(`Deleted meeting ${meetingName}.`);
  }

  function upsertRoom() {
    const input = roomForm.name.trim();
    if (!input) {
      setStatusText("Room name is required.");
      return;
    }

    if (editingRoomId) {
      setRooms((prev) => prev.map((room) => (
        room.id === editingRoomId
          ? { ...room, name: input }
          : room
      )));
      setStatusText(`Updated room ${input}.`);
      setRoomForm({ name: "" });
      setEditingRoomId(null);
      return;
    }

    // Parse comma-separated room names
    const roomNames = input
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (roomNames.length === 0) {
      setStatusText("Please enter at least one room name.");
      return;
    }

    const collectedIds = rooms.map((r) => r.id);
    const newRooms: Room[] = [];
    for (const name of roomNames) {
      const id = makeUniqueId(`room_${toSlug(name) || "item"}`, [...collectedIds, ...newRooms.map((r) => r.id)]);
      newRooms.push({ id, name });
    }

    setRooms((prev) => [...prev, ...newRooms]);
    const message = roomNames.length === 1 ? `Added room ${roomNames[0]}.` : `Added ${roomNames.length} rooms.`;
    setStatusText(message);
    setRoomForm({ name: "" });
  }

  function deleteRoom(roomId: string) {
    const roomName = rooms.find((room) => room.id === roomId)?.name ?? roomId;
    setRooms((prev) => prev.filter((room) => room.id !== roomId));
    setClasses((prev) => prev.map((cls) => (
      cls.base_room_id === roomId
        ? { ...cls, base_room_id: undefined }
        : cls
    )));
    if (editingRoomId === roomId) {
      setRoomForm({ name: "" });
      setEditingRoomId(null);
    }
    setStatusText(`Deleted room ${roomName}.`);
  }

  function loadRoomIntoForm(room: Room) {
    setRoomForm({ name: room.name });
    setEditingRoomId(room.id);
  }

  function resolveTeacherIdFromInput(inputValue: string): string | null {
    const normalizedInput = normalizeSearchText(inputValue);
    if (!normalizedInput) {
      return "";
    }
    const exactMatch = sortedTeachersByFirstName.find(
      (teacher) => normalizeSearchText(teacher.name) === normalizedInput
    );
    return exactMatch ? exactMatch.id : null;
  }

  function resolveTeacherIdsFromInput(inputValue: string): string[] | null {
    const tokens = inputValue
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return [];
    }

    const resolved: string[] = [];
    for (const token of tokens) {
      const normalizedToken = normalizeSearchText(token);
      const exactMatch = sortedTeachersByFirstName.find(
        (teacher) => normalizeSearchText(teacher.name) === normalizedToken
      );
      if (!exactMatch) {
        return null;
      }
      resolved.push(exactMatch.id);
    }

    return Array.from(new Set(resolved));
  }

  function getTeacherInputValue(entityId: string, currentTeacherId: string, currentTeacherIds: string[] = []): string {
    const draft = teacherSearchBySubjectEntity[entityId];
    if (typeof draft === "string") {
      return draft;
    }

    const teacherIds = Array.from(new Set([
      ...(currentTeacherId ? [currentTeacherId] : []),
      ...currentTeacherIds,
    ]));
    if (!teacherIds.length) {
      return "";
    }

    return teacherIds
      .map((teacherId) => sortedTeachersByFirstName.find((teacher) => teacher.id === teacherId)?.name ?? teacherId)
      .join(", ");
  }

  function getSubjectTeacherIds(subject: Subject): string[] {
    return Array.from(new Set([
      ...(subject.teacher_id ? [subject.teacher_id] : []),
      ...(subject.teacher_ids ?? []),
    ].filter(Boolean)));
  }

  function addTeachersToSubject(subject: Subject, teacherIdsToAdd: string[]) {
    const mergedTeacherIds = Array.from(new Set([
      ...getSubjectTeacherIds(subject),
      ...teacherIdsToAdd.filter(Boolean),
    ]));
    updateSubjectCard(subject.id, {
      teacher_id: mergedTeacherIds[0] ?? "",
      teacher_ids: mergedTeacherIds,
    });
  }

  function removeTeacherFromSubject(subject: Subject, teacherIdToRemove: string) {
    const nextTeacherIds = getSubjectTeacherIds(subject).filter((teacherId) => teacherId !== teacherIdToRemove);
    updateSubjectCard(subject.id, {
      teacher_id: nextTeacherIds[0] ?? "",
      teacher_ids: nextTeacherIds,
    });
  }

  const classNameById = useMemo(() => {
    return Object.fromEntries(sortedClasses.map((c) => [c.id, c.name])) as Record<string, string>;
  }, [sortedClasses]);

  const teacherNameById = useMemo(() => {
    return Object.fromEntries(teachers.map((teacher) => [teacher.id, teacher.name])) as Record<string, string>;
  }, [teachers]);

  const roomNameById = useMemo(() => {
    return Object.fromEntries(rooms.map((room) => [room.id, room.name])) as Record<string, string>;
  }, [rooms]);

  const classSubjectsById = useMemo(() => {
    const grouped: Record<string, Subject[]> = {};
    for (const schoolClass of sortedClasses) {
      grouped[schoolClass.id] = subjects
        .filter((subject) => subject.class_ids.includes(schoolClass.id))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return grouped;
  }, [sortedClasses, subjects]);

  const filteredFaggrupperClasses = useMemo(() => {
    const normalizedQuery = normalizeSearchText(faggrupperClassSearchQuery);
    if (!normalizedQuery) {
      return sortedClasses;
    }
    return sortedClasses.filter((schoolClass) =>
      normalizeSearchText(schoolClass.name).includes(normalizedQuery)
    );
  }, [sortedClasses, faggrupperClassSearchQuery]);

  useEffect(() => {
    if (!filteredFaggrupperClasses.length) {
      setActiveFaggruppeClassId(null);
      return;
    }
    if (!activeFaggruppeClassId || !filteredFaggrupperClasses.some((schoolClass) => schoolClass.id === activeFaggruppeClassId)) {
      setActiveFaggruppeClassId(filteredFaggrupperClasses[0].id);
    }
  }, [filteredFaggrupperClasses, activeFaggruppeClassId]);

  const compareEntities = useMemo(() => {
    const entities: CompareEntity[] = [];

    for (const classId of selectedClassCompareIds) {
      entities.push({
        id: `class:${classId}`,
        label: classNameById[classId] ?? classId,
        kind: "class",
        color: COMPARE_PALETTE[entities.length % COMPARE_PALETTE.length],
      });
    }

    for (const teacherId of selectedTeacherCompareIds) {
      entities.push({
        id: `teacher:${teacherId}`,
        label: teacherNameById[teacherId] ?? teacherId,
        kind: "teacher",
        color: COMPARE_PALETTE[entities.length % COMPARE_PALETTE.length],
      });
    }

    for (const roomId of selectedRoomCompareIds) {
      entities.push({
        id: `room:${roomId}`,
        label: roomNameById[roomId] ?? roomId,
        kind: "room",
        color: COMPARE_PALETTE[entities.length % COMPARE_PALETTE.length],
      });
    }

    return entities;
  }, [selectedClassCompareIds, selectedTeacherCompareIds, selectedRoomCompareIds, classNameById, teacherNameById, roomNameById]);

  const compareEntityIndex = useMemo(() => {
    return Object.fromEntries(compareEntities.map((entity, idx) => [entity.id, idx])) as Record<string, number>;
  }, [compareEntities]);

  const displaySchedule = useMemo(() => mergeScheduleForDisplay(schedule), [schedule]);

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
      .sort((a, b) => {
        const typeRankA = a.subject.subject_type === "fellesfag" ? 0 : 1;
        const typeRankB = b.subject.subject_type === "fellesfag" ? 0 : 1;
        if (typeRankA !== typeRankB) {
          return typeRankA - typeRankB;
        }
        return a.subject.name.localeCompare(b.subject.name);
      });
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

  // Build a map: subject_id → block info (for displaying block name in schedules)
  const subjectToBlockInfo = useMemo(() => {
    const map = new Map<string, { block_id: string; block_name: string; class_ids: string[] }>();
    for (const block of blocks) {
      for (const entry of block.subject_entries ?? []) {
        map.set(entry.subject_id, {
          block_id: block.id,
          block_name: block.name,
          class_ids: block.class_ids ?? [],
        });
      }
      for (const subject_id of block.subject_ids ?? []) {
        map.set(subject_id, {
          block_id: block.id,
          block_name: block.name,
          class_ids: block.class_ids ?? [],
        });
      }
    }
    return map;
  }, [blocks]);

  const blockWeekTypeBySlot = useMemo(() => {
    const map = new Map<string, "A" | "B" | undefined>();

    const normalizeOccWeek = (value: string | undefined): "A" | "B" | "both" => {
      if (value === "A" || value === "B") {
        return value;
      }
      return "both";
    };

    const weekPatternToOccWeek = (value: string | undefined): "A" | "B" | "both" => {
      if (value === "A" || value === "B") {
        return value;
      }
      return "both";
    };

    const addWeekToSet = (set: Set<"A" | "B">, occWeek: "A" | "B" | "both") => {
      if (occWeek === "A") {
        set.add("A");
      } else if (occWeek === "B") {
        set.add("B");
      } else {
        set.add("A");
        set.add("B");
      }
    };

    for (const block of blocks) {
      const weekBySlot = new Map<string, Set<"A" | "B">>();
      const hasOccurrences = (block.occurrences ?? []).length > 0;

      for (const occ of block.occurrences ?? []) {
        const occWeek = normalizeOccWeek(occ.week_type);
        const occStart = toMinutes(occ.start_time);
        const occEnd = toMinutes(occ.end_time);

        for (const ts of timeslots) {
          if (ts.day.toLowerCase() !== occ.day.toLowerCase()) {
            continue;
          }

          let overlaps = true;
          const tsStart = toMinutes(ts.start_time);
          const tsEnd = toMinutes(ts.end_time);
          if (
            tsStart !== Number.MAX_SAFE_INTEGER &&
            tsEnd !== Number.MAX_SAFE_INTEGER &&
            occStart !== Number.MAX_SAFE_INTEGER &&
            occEnd !== Number.MAX_SAFE_INTEGER
          ) {
            overlaps = tsStart < occEnd && tsEnd > occStart;
          }

          if (!overlaps) {
            continue;
          }

          const set = weekBySlot.get(ts.id) ?? new Set<"A" | "B">();
          addWeekToSet(set, occWeek);
          weekBySlot.set(ts.id, set);
        }
      }

      if (!hasOccurrences) {
        for (const tsId of block.timeslot_ids ?? []) {
          const set = weekBySlot.get(tsId) ?? new Set<"A" | "B">();
          addWeekToSet(set, weekPatternToOccWeek(block.week_pattern));
          weekBySlot.set(tsId, set);
        }
      }

      for (const [tsId, weeks] of weekBySlot.entries()) {
        const hasA = weeks.has("A");
        const hasB = weeks.has("B");
        const displayWeek: "A" | "B" | undefined = hasA && hasB
          ? undefined
          : hasA
            ? "A"
            : hasB
              ? "B"
              : undefined;
        map.set(`${block.id}|${tsId}`, displayWeek);
      }
    }

    return map;
  }, [blocks, timeslots]);

  useEffect(() => {
    timeslotsRef.current = timeslots;
  }, [timeslots]);

  function applyNormalizedTimeslotState(nextTimeslots: Timeslot[], focusTimeslotId?: string | null): string | null {
    const { normalizedTimeslots, idMap } = normalizeTimeslotIds(nextTimeslots);
    const remapId = (id: string): string => idMap[id] ?? id;

    setTimeslots(normalizedTimeslots.map((timeslot) => normalizeTimeslot(timeslot)));

    setBlocks((prev) => prev.map((block) => ({
      ...block,
      timeslot_ids: Array.from(new Set((block.timeslot_ids ?? []).map(remapId))),
    })));

    setTeachers((prev) => prev.map((teacher) => ({
      ...teacher,
      preferred_avoid_timeslots: Array.from(new Set(teacher.preferred_avoid_timeslots.map(remapId))),
      unavailable_timeslots: Array.from(new Set(teacher.unavailable_timeslots.map(remapId))),
    })));

    setMeetings((prev) => prev.map((meeting) => ({
      ...meeting,
      timeslot_id: remapId(meeting.timeslot_id),
    })));

    setSubjects((prev) => prev.map((subject) => ({
      ...subject,
      allowed_timeslots: subject.allowed_timeslots
        ? Array.from(new Set(subject.allowed_timeslots.map(remapId)))
        : undefined,
      force_timeslot_id: subject.force_timeslot_id ? remapId(subject.force_timeslot_id) : undefined,
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

  useEffect(() => {
    setMeetingForm((prev) => {
      if (prev.timeslot_id && sortedTimeslots.some((slot) => slot.id === prev.timeslot_id)) {
        return prev;
      }
      const fallbackTimeslotId = sortedTimeslots[0]?.id ?? "";
      if (prev.timeslot_id === fallbackTimeslotId) {
        return prev;
      }
      return {
        ...prev,
        timeslot_id: fallbackTimeslotId,
      };
    });
  }, [sortedTimeslots]);

  function addTeacher() {
    if (!teacherForm.name) {
      return;
    }
    const workloadPercent = Math.min(100, Math.max(1, Number.parseInt(teacherForm.workload_percent, 10) || 100));
    const id = makeUniqueId(`teacher_${toSlug(teacherForm.name) || "item"}`, teachers.map((t) => t.id));
    setTeachers((prev) => [
      ...prev,
      {
        id,
        name: teacherForm.name,
        avdeling: "",
        preferred_avoid_timeslots: [],
        unavailable_timeslots: splitCsv(teacherForm.unavailable_timeslots),
        workload_percent: workloadPercent,
      },
    ]);
    setTeacherForm({ name: "", unavailable_timeslots: "", workload_percent: "100" });
  }

  function deleteTeacher(teacherId: string) {
    setTeachers((prev) => prev.filter((t) => t.id !== teacherId));
    setMeetings((prev) => prev.map((meeting) => ({
      ...meeting,
      teacher_assignments: meeting.teacher_assignments.filter((assignment) => assignment.teacher_id !== teacherId),
    })));
    if (expandedTeacherId === teacherId) {
      setExpandedTeacherId(null);
    }
  }

  function handleExcelUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    processExcelFile(file);
  }

  function processExcelFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet) as Array<{ [key: string]: unknown }>;

        const newTeachers: Teacher[] = [];
        const existingIds = teachers.map((t) => t.id);

        jsonData.forEach((row) => {
          let name = "";
          let avdeling = "";

          // Try Norwegian names first (Fornavn = first name, Etternavn = last name)
          const fornavnKey = Object.keys(row).find((key) => key.toLowerCase() === "fornavn");
          const etternavnKey = Object.keys(row).find((key) => key.toLowerCase() === "etternavn");

          if (fornavnKey && etternavnKey) {
            const fornavn = String(row[fornavnKey] || "").trim();
            const etternavn = String(row[etternavnKey] || "").trim();
            if (fornavn || etternavn) {
              name = `${fornavn} ${etternavn}`.trim();
            }
          }

          // Fallback to generic name/teacher column
          if (!name) {
            const nameKey = Object.keys(row).find(
              (key) => key.toLowerCase().includes("name") || key.toLowerCase().includes("teacher")
            );
            if (nameKey && row[nameKey]) {
              name = String(row[nameKey]).trim();
            }
          }

          if (!name) return;

          const avdelingKey = Object.keys(row).find((key) => key.toLowerCase() === "avdeling");
          if (avdelingKey) {
            avdeling = extractAvdeling(String(row[avdelingKey] || ""));
          }

          const id = makeUniqueId(`teacher_${toSlug(name) || "item"}`, [...existingIds, ...newTeachers.map((t) => t.id)]);
          newTeachers.push({
            id,
            name,
            avdeling,
            preferred_avoid_timeslots: [],
            unavailable_timeslots: [],
            workload_percent: 100,
          });
        });

        setTeachers((prev) => [...prev, ...newTeachers]);
        if (excelFileRef.current) {
          excelFileRef.current.value = "";
        }
        setStatusText(`Imported ${newTeachers.length} teachers from Excel.`);
      } catch (error) {
        console.error("Error parsing Excel:", error);
        setStatusText("Error parsing Excel file.");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv")) {
        processExcelFile(file);
      } else {
        setStatusText("Please drop a .xlsx, .xls, or .csv file");
      }
    }
  }

  function toggleTeacherTimeslot(teacherId: string, timeslotId: string) {
    setTeachers((prev) =>
      prev.map((teacher) => {
        if (teacher.id !== teacherId) return teacher;
        const updated = { ...teacher };

        // Cycle states: available -> preferred(orange) -> unavailable(red) -> available
        if (updated.unavailable_timeslots.includes(timeslotId)) {
          updated.unavailable_timeslots = updated.unavailable_timeslots.filter((t) => t !== timeslotId);
          return updated;
        }

        if (updated.preferred_avoid_timeslots.includes(timeslotId)) {
          updated.preferred_avoid_timeslots = updated.preferred_avoid_timeslots.filter((t) => t !== timeslotId);
          updated.unavailable_timeslots = [...updated.unavailable_timeslots, timeslotId];
          return updated;
        }

        updated.preferred_avoid_timeslots = [...updated.preferred_avoid_timeslots, timeslotId];
        return updated;
      })
    );
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
      subject_entries: (block.subject_entries ?? []).filter((se) => se.subject_id !== subjectId),
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

  function clearAllFellesfagTeachers() {
    const fellesfagIds = new Set(
      subjects
        .filter((subject) => subject.subject_type === "fellesfag")
        .map((subject) => subject.id),
    );

    if (fellesfagIds.size === 0) {
      setStatusText("No fellesfag subjects found.");
      return;
    }

    let clearedCount = 0;
    const nextSubjects = subjects.map((subject) => {
      if (subject.subject_type !== "fellesfag" || (!subject.teacher_id && !(subject.teacher_ids?.length ?? 0))) {
        return subject;
      }

      clearedCount += 1;
      return {
        ...subject,
        teacher_id: "",
        teacher_ids: [],
      };
    });

    setSubjects(nextSubjects);
    setTeacherSearchBySubjectEntity((prev) => {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!key.startsWith("faggrupper_")) {
          next[key] = value;
          continue;
        }

        const subjectId = key.slice("faggrupper_".length);
        if (!fellesfagIds.has(subjectId)) {
          next[key] = value;
        }
      }
      return next;
    });

    if (clearedCount === 0) {
      setStatusText("No teacher assignments to clear in fellesfag.");
      return;
    }

    setStatusText(`Cleared ${clearedCount} teacher assignment(s) across all fellesfag subjects.`);
  }

  function addSubjectToClass(subject: Subject, classId: string, currentClassIds: string[]) {
    if (!classId) {
      return;
    }

    if (subject.subject_type === "fellesfag") {
      addFellesfagToClass(classId, subject.id);
      return;
    }

    if (currentClassIds.includes(classId)) {
      return;
    }

    updateSubjectCard(subject.id, { class_ids: [...currentClassIds, classId] });
    const className = classNameById[classId] ?? classId;
    setStatusText(`Added ${subject.name} to ${className}.`);
  }

  function removeSubjectFromClass(subject: Subject, classId: string) {
    if (subject.subject_type === "fellesfag") {
      const copy = subjects.find(
        (s) =>
          s.subject_type === "fellesfag" &&
          s.name === subject.name &&
          s.class_ids.length === 1 &&
          s.class_ids[0] === classId
      );
      if (!copy) {
        return;
      }
      removeFellesfagFromClass(classId, copy.id);
      return;
    }

    updateSubjectCard(subject.id, {
      class_ids: subject.class_ids.filter((id) => id !== classId),
    });
    const className = classNameById[classId] ?? classId;
    setStatusText(`Removed ${subject.name} from ${className}.`);
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
        excluded_from_generation: timeslotForm.excluded_from_generation,
        generation_allowed_class_ids: timeslotForm.excluded_from_generation ? timeslotForm.generation_allowed_class_ids : [],
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
      excluded_from_generation: Boolean(slot.excluded_from_generation),
      generation_allowed_class_ids: slot.generation_allowed_class_ids ?? [],
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
      excluded_from_generation: false,
      generation_allowed_class_ids: [],
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
        excluded_from_generation: timeslotForm.excluded_from_generation,
        generation_allowed_class_ids: timeslotForm.excluded_from_generation ? timeslotForm.generation_allowed_class_ids : [],
      };
    });

    const normalizedId = applyNormalizedTimeslotState(nextTimeslots, timeslotId) ?? timeslotId;

    setTimeslotForm((s) => ({ ...s, day, start_time: start24, end_time: end24 }));
    setActiveCalendarDay(day);
    setEditingTimeslotId(null);
    setStatusText(`Updated timeslot ${normalizedId}.`);
  }

  function resetBlockForm() {
    setBlockForm({ name: "", occurrences: [], class_ids: [], subject_entries: [] });
    setBlockOccForm({ day: "Monday", start_time: "08:20", end_time: "09:50", week_type: "both" });
    setBlockSubjForm({ subject_id: "", teacher_id: "", preferred_room_id: "", new_subject_name: "" });
    setEditingBlockId(null);
  }

  function addOccurrenceToBlockForm() {
    if (!blockOccForm.start_time || !blockOccForm.end_time) return;
    const occ: BlockOccurrence = {
      id: `occ_${Date.now()}`,
      day: blockOccForm.day,
      start_time: blockOccForm.start_time,
      end_time: blockOccForm.end_time,
      week_type: blockOccForm.week_type,
    };
    setBlockForm((prev) => ({ ...prev, occurrences: [...prev.occurrences, occ] }));
  }

  function removeOccurrenceFromBlockForm(occId: string) {
    setBlockForm((prev) => ({ ...prev, occurrences: prev.occurrences.filter((o) => o.id !== occId) }));
  }

  function toggleBlockClass(classId: string) {
    setBlockForm((prev) => ({
      ...prev,
      class_ids: prev.class_ids.includes(classId)
        ? prev.class_ids.filter((id) => id !== classId)
        : [...prev.class_ids, classId],
    }));
  }

  function blockOccurrenceSessionCount(occurrences: BlockOccurrence[] | undefined): number {
    return Math.max(1, occurrences?.length ?? 0);
  }

  function addSubjectToBlockForm() {
    if (!blockSubjForm.subject_id) return;
    if (blockForm.subject_entries.some((se) => se.subject_id === blockSubjForm.subject_id)) return;
    const nextSessions = blockOccurrenceSessionCount(blockForm.occurrences);
    setSubjects((prev) => prev.map((subject) => (
      subject.id === blockSubjForm.subject_id
        ? { ...subject, sessions_per_week: nextSessions }
        : subject
    )));
    setBlockForm((prev) => ({
      ...prev,
      subject_entries: [
        ...prev.subject_entries,
        { subject_id: blockSubjForm.subject_id, teacher_id: blockSubjForm.teacher_id, preferred_room_id: blockSubjForm.preferred_room_id },
      ],
    }));
    setBlockSubjForm({ subject_id: "", teacher_id: "", preferred_room_id: "", new_subject_name: "" });
  }

  function createAndAddSubjectToBlock() {
    const name = blockSubjForm.new_subject_name.trim();
    if (!name) return;
    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((s) => s.id));
    const occurrenceCount = blockOccurrenceSessionCount(blockForm.occurrences);
    const newSubject: Subject = {
      id,
      name,
      teacher_id: blockSubjForm.teacher_id,
      teacher_ids: blockSubjForm.teacher_id ? [blockSubjForm.teacher_id] : [],
      class_ids: [],
      subject_type: "programfag",
      sessions_per_week: occurrenceCount,
    };
    setSubjects((prev) => [...prev, newSubject]);
    if (!blockForm.subject_entries.some((se) => se.subject_id === id)) {
      setBlockForm((prev) => ({
        ...prev,
        subject_entries: [
          ...prev.subject_entries,
          { subject_id: id, teacher_id: blockSubjForm.teacher_id, preferred_room_id: blockSubjForm.preferred_room_id },
        ],
      }));
    }
    setBlockSubjForm({ subject_id: "", teacher_id: "", preferred_room_id: "", new_subject_name: "" });
  }

  function createAndAddSubjectToSavedBlock(blockId: string) {
    const name = (blockInlineSubjNames[blockId] ?? "").trim();
    if (!name) return;
    const block = blocks.find((b) => b.id === blockId);
    const occurrenceCount = blockOccurrenceSessionCount(block?.occurrences);
    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((s) => s.id));
    // alternating_week_split removed - auto-balancing is used instead
    setSubjects((prev) => [...prev, { id, name, teacher_id: "", teacher_ids: [], class_ids: [], subject_type: "programfag", sessions_per_week: occurrenceCount }]);
    setBlocks((prev) => prev.map((b) =>
      b.id !== blockId ? b : {
        ...b,
        subject_entries: b.subject_entries.some((se) => se.subject_id === id)
          ? b.subject_entries
          : [...b.subject_entries, { subject_id: id, teacher_id: "", preferred_room_id: "" }],
      }
    ));
    setBlockInlineSubjNames((prev) => ({ ...prev, [blockId]: "" }));
  }

  function removeSubjectFromBlockForm(subjectId: string) {
    setBlockForm((prev) => ({
      ...prev,
      subject_entries: prev.subject_entries.filter((se) => se.subject_id !== subjectId),
    }));
  }

  function updateBlockSubjectEntry(blockId: string, subjectId: string, patch: Partial<BlockSubjectEntry>) {
    setBlocks((prev) => prev.map((b) =>
      b.id !== blockId ? b : {
        ...b,
        subject_entries: b.subject_entries.map((se) =>
          se.subject_id !== subjectId ? se : { ...se, ...patch }
        ),
      }
    ));
  }

  function handleBlockCardClick(blockId: string) {
    setExpandedBlockId((prev) => {
      if (!prev) return prev;
      if (prev === blockId) return prev;
      return null;
    });
  }

  function loadBlockIntoForm(block: Block) {
    setBlockForm({
      name: block.name,
      occurrences: block.occurrences ?? [],
      class_ids: block.class_ids ?? [],
      subject_entries: block.subject_entries ?? [],
    });
    setEditingBlockId(block.id);
  }

  function deleteBlock(blockId: string) {
    setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    if (editingBlockId === blockId) resetBlockForm();
  }

  function upsertBlock() {
    if (!blockForm.name) return;
    const nextSessions = blockOccurrenceSessionCount(blockForm.occurrences);
    const blockSubjectIds = new Set(blockForm.subject_entries.map((se) => se.subject_id));
    if (blockSubjectIds.size > 0) {
      setSubjects((prev) => prev.map((subject) => (
        blockSubjectIds.has(subject.id)
          ? { ...subject, sessions_per_week: nextSessions }
          : subject
      )));
    }
    if (editingBlockId) {
      setBlocks((prev) => prev.map((b) =>
        b.id === editingBlockId
          ? {
              ...b,
              name: blockForm.name,
              occurrences: blockForm.occurrences,
              class_ids: blockForm.class_ids,
              subject_entries: blockForm.subject_entries,
              timeslot_ids: [],
              week_pattern: "both",
            }
          : b
      ));
    } else {
      const id = makeUniqueId(`block_${toSlug(blockForm.name) || "item"}`, blocks.map((b) => b.id));
      setBlocks((prev) => [
        ...prev,
        {
          id,
          name: blockForm.name,
          occurrences: blockForm.occurrences,
          class_ids: blockForm.class_ids,
          subject_entries: blockForm.subject_entries,
          timeslot_ids: [],
        },
      ]);
    }
    resetBlockForm();
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
      timeslot_ids: Array.from(new Set((block.timeslot_ids ?? []).filter((id) => id !== timeslotId).map(remapId))),
    })));

    setTeachers((prev) => prev.map((teacher) => ({
      ...teacher,
      preferred_avoid_timeslots: Array.from(
        new Set(teacher.preferred_avoid_timeslots.filter((id) => id !== timeslotId).map(remapId)),
      ),
      unavailable_timeslots: Array.from(
        new Set(teacher.unavailable_timeslots.filter((id) => id !== timeslotId).map(remapId)),
      ),
    })));

    setMeetings((prev) => prev
      .filter((meeting) => meeting.timeslot_id !== timeslotId)
      .map((meeting) => ({
        ...meeting,
        timeslot_id: remapId(meeting.timeslot_id),
      })));

    setSubjects((prev) => prev.map((subject) => ({
      ...subject,
      allowed_timeslots: subject.allowed_timeslots
        ? Array.from(new Set(subject.allowed_timeslots.filter((id) => id !== timeslotId).map(remapId)))
        : undefined,
      force_timeslot_id:
        subject.force_timeslot_id === timeslotId
          ? undefined
          : (subject.force_timeslot_id ? remapId(subject.force_timeslot_id) : undefined),
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
        teacher_ids: [],
        class_ids: [],
        subject_type: "fellesfag",
        sessions_per_week: 1,
        force_place: false,
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
      const mergedTeacherIds = Array.from(new Set([
        ...(typeof merged.teacher_id === "string" && merged.teacher_id.trim() ? [merged.teacher_id.trim()] : []),
        ...(Array.isArray(merged.teacher_ids)
          ? merged.teacher_ids.map((id) => String(id).trim()).filter(Boolean)
          : []),
      ]));
      return {
        ...merged,
        teacher_id: mergedTeacherIds[0] ?? "",
        teacher_ids: mergedTeacherIds,
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
      subject_entries: (block.subject_entries ?? []).filter((se) => !toRemove.has(se.subject_id)),
    })));
    setStatusText(`Deleted subject and ${toRemove.size - 1} class assignment(s).`);
  }

  async function generateSchedule() {
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setLoading(true);
    setStatusText(`Generating schedule (run ${runId})...`);
    setSchedule([]);

    try {
      const blockReferencedSubjectIds = new Set<string>([
        ...(blocks ?? []).flatMap((block) => block.subject_ids ?? []),
        ...(blocks ?? []).flatMap((block) => (block.subject_entries ?? []).map((entry) => entry.subject_id)),
      ]);

      // Ensure all arrays are properly defined
      const cleanSubjects = subjects
        .filter((s) => {
          if (!s.id) {
            return false;
          }
          // Do not send unassigned fellesfag templates (class_ids.length === 0)
          // unless they are explicitly referenced by a block.
          if (s.subject_type === "fellesfag" && (s.class_ids ?? []).length === 0) {
            return blockReferencedSubjectIds.has(s.id);
          }
          return true;
        })
        .map((s) => ({
          ...s,
          teacher_ids: Array.from(new Set([
            ...(s.teacher_id ? [s.teacher_id] : []),
            ...((s.teacher_ids ?? []).filter(Boolean)),
          ])),
          teacher_id: (Array.from(new Set([
            ...(s.teacher_id ? [s.teacher_id] : []),
            ...((s.teacher_ids ?? []).filter(Boolean)),
          ]))[0] ?? ""),
          class_ids: s.class_ids ?? [],
          sessions_per_week: s.sessions_per_week || 1,
          force_place: Boolean(s.force_place),
          force_timeslot_id:
            typeof s.force_timeslot_id === "string" && s.force_timeslot_id.trim()
              ? s.force_timeslot_id.trim()
              : undefined,
          // alternating_week_split is DISABLED - auto-balancing is used instead
          allowed_block_ids: s.allowed_block_ids ?? undefined,
          allowed_timeslots: s.allowed_timeslots ?? undefined,
        }));

      const payload = {
        subjects: cleanSubjects,
        teachers: teachers ?? [],
        meetings: meetings ?? [],
        rooms: rooms ?? [],
        classes: classes ?? [],
        timeslots: timeslots ?? [],
        alternating_weeks_enabled: enableAlternatingWeeks,
        alternate_non_block_subjects: alternateNonBlockSubjects,
        blocks: (blocks ?? []).map((block) => ({
          id: block.id,
          name: block.name,
          occurrences: block.occurrences ?? [],
          class_ids: block.class_ids ?? [],
          subject_entries: block.subject_entries ?? [],
          timeslot_ids: block.timeslot_ids ?? [],
          subject_ids: block.subject_ids ?? [],
        })),
      };

      let bodyStr: string;
      try {
        bodyStr = JSON.stringify(payload);
      } catch (err) {
        throw new Error(`Could not serialize payload: ${err instanceof Error ? err.message : String(err)}`);
      }

      const res = await fetch(`${API_BASE}/generate-schedule?run=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "X-Run-Id": String(runId),
        },
        body: bodyStr,
      });

      if (!res.ok) {
        let detail = `Server error ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody?.detail) detail = `Error: ${errBody.detail}`;
        } catch (_) { /* ignore parse failure */ }
        throw new Error(detail);
      }

      const data: GenerateResponse = await res.json();
      setStatusText(formatGeneratedScheduleStatus(data, runId));
      setSchedule(data.schedule || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatusText(`Failed (run ${runId}): ${message}`);
    } finally {
      setLoading(false);
    }
  }

  function clearGeneratedSchedule() {
    setSchedule([]);
    setStatusText("Generated schedule cleared. Inputs and constraints are unchanged.");
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
    <main className={showUltrawideTimeline ? "ultrawide-mode" : ""}>
      <section className="hero">
        <div className="hero-title-row">
          <h1>School Scheduling Studio</h1>
          <button
            type="button"
            className="secondary hero-ultrawide-toggle"
            onClick={() => setShowUltrawideTimeline((prev) => !prev)}
          >
            {showUltrawideTimeline ? "Exit Ultrawide" : "Show Ultrawide"}
          </button>
        </div>
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

          <label className="calendar-check">
            <input
              type="checkbox"
              checked={timeslotForm.excluded_from_generation}
              onChange={(e) => setTimeslotForm((s) => ({
                ...s,
                excluded_from_generation: e.target.checked,
                generation_allowed_class_ids: e.target.checked ? s.generation_allowed_class_ids : [],
              }))}
            />
            Exclude from generation
          </label>

          {timeslotForm.excluded_from_generation ? (
            <div className="calendar-field" style={{ gridColumn: "1 / -1" }}>
              <label>Not Excluded For Classes</label>
              <div className="meeting-chip-row">
                {sortedClasses.length === 0 ? (
                  <span className="meeting-empty">No classes available</span>
                ) : (
                  sortedClasses.map((schoolClass) => {
                    const isSelected = timeslotForm.generation_allowed_class_ids.includes(schoolClass.id);
                    return (
                      <button
                        key={schoolClass.id}
                        type="button"
                        className={`meeting-chip ${isSelected ? "preferred" : "neutral"}`}
                        style={{ width: "auto" }}
                        onClick={() => setTimeslotForm((s) => ({
                          ...s,
                          generation_allowed_class_ids: isSelected
                            ? s.generation_allowed_class_ids.filter((id) => id !== schoolClass.id)
                            : [...s.generation_allowed_class_ids, schoolClass.id],
                        }))}
                      >
                        {schoolClass.name}
                      </button>
                    );
                  })
                )}
              </div>
              <p style={{ marginTop: "4px", fontSize: "0.78rem" }}>
                This slot stays excluded for all other classes.
              </p>
            </div>
          ) : null}

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
                        className={`slot-pill ${getSlotToneClass(slot)}${slot.excluded_from_generation ? " excluded" : ""}`}
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
                        {slot.excluded_from_generation ? (
                          <small>
                            Excluded from generation
                            {(slot.generation_allowed_class_ids?.length ?? 0) > 0
                              ? ` except ${slot.generation_allowed_class_ids?.map((id) => classNameById[id] ?? id).join(", ")}`
                              : ""}
                          </small>
                        ) : null}
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

                      <div className="calendar-field" style={{ display: "none" }}>
                        <label>A/B Week Split (DISABLED - Auto-balancing is used)</label>
                        <input
                          type="text"
                          value=""
                          disabled
                          placeholder="e.g. 4/6"
                        />
                      </div>

                      <div className="subject-card-action">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => deleteSubjectCard(subject.id)}
                        >
                          Delete Subject
                        </button>
                      </div>
                    </div>

                    <div className="subject-class-manager">
                      <span className="subject-teacher-section-title">Classes With Subject</span>

                      <div className="subject-class-manager-chips">
                        {derivedClassIds.length === 0 ? (
                          <span className="subject-class-empty">No classes assigned</span>
                        ) : (
                          derivedClassIds
                            .slice()
                            .sort((a, b) => (classNameById[a] ?? a).localeCompare(classNameById[b] ?? b))
                            .map((cid) => (
                              <span key={cid} className="subject-class-chip subject-class-chip-editable">
                                {classNameById[cid] ?? cid}
                                <button
                                  type="button"
                                  className="subject-class-chip-remove"
                                  onClick={() => removeSubjectFromClass(subject, cid)}
                                  aria-label={`Remove ${classNameById[cid] ?? cid}`}
                                >
                                  x
                                </button>
                              </span>
                            ))
                        )}
                      </div>

                      <div className="subject-class-manager-add">
                        <select
                          value={subjectClassSelectionBySubject[subject.id] ?? ""}
                          onChange={(e) =>
                            setSubjectClassSelectionBySubject((prev) => ({
                              ...prev,
                              [subject.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">Select class to add</option>
                          {sortedClasses
                            .filter((schoolClass) => !derivedClassIds.includes(schoolClass.id))
                            .map((schoolClass) => (
                              <option key={schoolClass.id} value={schoolClass.id}>
                                {schoolClass.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            const classId = subjectClassSelectionBySubject[subject.id] ?? "";
                            addSubjectToClass(subject, classId, derivedClassIds);
                            setSubjectClassSelectionBySubject((prev) => ({
                              ...prev,
                              [subject.id]: "",
                            }));
                          }}
                          disabled={!subjectClassSelectionBySubject[subject.id]}
                        >
                          Add Class
                        </button>
                      </div>
                    </div>

                  </div>
                )}
              </article>
            ))}
          </div>
        </article>
      </section>
      )}

      {activeTab === "faggrupper" && (
      <section className="grid">
        <article className="card" style={{ gridColumn: "1 / -1" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "10px" }}>
            <h2 style={{ margin: 0 }}>Fellesfag</h2>
            <button
              type="button"
              onClick={clearAllFellesfagTeachers}
              style={{ marginLeft: "auto", width: "auto", minWidth: 0, padding: "3px 8px", fontSize: "0.74rem", lineHeight: 1, whiteSpace: "nowrap" }}
              disabled={
                !subjects.some((subject) => subject.subject_type === "fellesfag" && (Boolean(subject.teacher_id) || (subject.teacher_ids?.length ?? 0) > 0)) &&
                !Object.keys(teacherSearchBySubjectEntity).some((key) => key.startsWith("faggrupper_"))
              }
            >
              Clear Teachers
            </button>
          </div>
          <p>Select a class to view its subjects and set teachers.</p>

          <div className="faggrupper-layout">
            <aside className="faggrupper-classes list">
              <input
                value={faggrupperClassSearchQuery}
                onChange={(e) => setFaggrupperClassSearchQuery(e.target.value)}
                placeholder="Search classes"
                style={{ marginBottom: "6px" }}
              />
              {filteredFaggrupperClasses.map((schoolClass) => (
                <button
                  key={schoolClass.id}
                  type="button"
                  className={`faggrupper-class-item${activeFaggruppeClassId === schoolClass.id ? " active" : ""}`}
                  onClick={() => setActiveFaggruppeClassId(schoolClass.id)}
                >
                  <span>{schoolClass.name}</span>
                  <span>{(classSubjectsById[schoolClass.id] ?? []).length}</span>
                </button>
              ))}
              {filteredFaggrupperClasses.length === 0 ? (
                <p style={{ margin: "4px 0", color: "#777", fontSize: "0.78rem" }}>No class matches.</p>
              ) : null}
            </aside>

            <section className="faggrupper-subjects">
              {activeFaggruppeClassId ? (
                <>
                  <h3>
                    {classNameById[activeFaggruppeClassId] ?? activeFaggruppeClassId}
                  </h3>
                  <div className="faggrupper-subject-list">
                    {(classSubjectsById[activeFaggruppeClassId] ?? []).length === 0 ? (
                      <p>No subjects assigned to this class yet.</p>
                    ) : (
                      (classSubjectsById[activeFaggruppeClassId] ?? []).map((subject) => {
                        const searchKey = `faggrupper_${subject.id}`;
                        const assignedTeacherIds = getSubjectTeacherIds(subject);
                        const teacherDraft = teacherSearchBySubjectEntity[searchKey] ?? "";
                        const isClassCopy =
                          subject.class_ids.length === 1 &&
                          subject.class_ids[0] === activeFaggruppeClassId;
                        return (
                          <div key={`${activeFaggruppeClassId}_${subject.id}`} className="subject-teacher-row faggrupper-subject-row">
                            <span className="subject-teacher-classname">{subject.name}</span>
                            <div className="faggrupper-units-field" title={isClassCopy ? "Edit weekly units for this class copy." : "Only class-specific copies can be edited here."}>
                              <label>45m</label>
                              <input
                                type="number"
                                min={1}
                                value={subject.sessions_per_week}
                                disabled={!isClassCopy}
                                onChange={(e) => {
                                  const value = Math.max(1, Math.floor(Number(e.target.value) || 1));
                                  updateSubjectCard(subject.id, {
                                    sessions_per_week: value,
                                  });
                                }}
                              />
                            </div>
                            <div
                              className="faggrupper-units-field faggrupper-force-field"
                              title={
                                isClassCopy && subject.subject_type === "fellesfag"
                                  ? "Force one weekly placement into a specific slot (can overlap with blocks)."
                                  : "Only class-specific fellesfag can be force-placed here."
                              }
                            >
                              <label className="faggrupper-force-label">
                                <input
                                  type="checkbox"
                                  checked={Boolean(subject.force_place)}
                                  disabled={!isClassCopy || subject.subject_type !== "fellesfag"}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    updateSubjectCard(subject.id, {
                                      force_place: checked,
                                      force_timeslot_id: checked ? subject.force_timeslot_id : undefined,
                                    });
                                  }}
                                />
                                Force
                              </label>
                              <select
                                value={subject.force_timeslot_id ?? ""}
                                disabled={!isClassCopy || subject.subject_type !== "fellesfag" || !subject.force_place}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  updateSubjectCard(subject.id, {
                                    force_place: Boolean(subject.force_place),
                                    force_timeslot_id: value || undefined,
                                  });
                                }}
                              >
                                <option value="">Select slot</option>
                                {sortedTimeslots.map((ts) => (
                                  <option key={ts.id} value={ts.id}>
                                    {ts.day} P{ts.period}
                                    {ts.start_time && ts.end_time ? ` (${ts.start_time}-${ts.end_time})` : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="faggrupper-teacher-picker">
                              <div className="faggrupper-teacher-selected">
                                {assignedTeacherIds.length === 0 ? (
                                  <span className="faggrupper-teacher-empty">No teachers</span>
                                ) : (
                                  assignedTeacherIds.map((teacherId) => (
                                    <span key={`${subject.id}_${teacherId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip">
                                      {teacherNameById[teacherId] ?? teacherId}
                                      <button
                                        type="button"
                                        className="subject-class-chip-remove"
                                        onClick={() => removeTeacherFromSubject(subject, teacherId)}
                                        aria-label={`Remove teacher ${teacherNameById[teacherId] ?? teacherId}`}
                                      >
                                        x
                                      </button>
                                    </span>
                                  ))
                                )}
                              </div>
                              <div className="faggrupper-teacher-add-row">
                                <input
                                  list={`faggrupper-teacher-options-${activeFaggruppeClassId}-${subject.id}`}
                                  value={teacherDraft}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    const resolvedTeacherId = resolveTeacherIdFromInput(nextValue);
                                    if (resolvedTeacherId) {
                                      addTeachersToSubject(subject, [resolvedTeacherId]);
                                      setTeacherSearchBySubjectEntity((prev) => ({
                                        ...prev,
                                        [searchKey]: "",
                                      }));
                                      return;
                                    }

                                    setTeacherSearchBySubjectEntity((prev) => ({
                                      ...prev,
                                      [searchKey]: nextValue,
                                    }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") {
                                      return;
                                    }
                                    e.preventDefault();
                                    const resolvedTeacherIds = resolveTeacherIdsFromInput(teacherDraft);
                                    if (resolvedTeacherIds === null) {
                                      setStatusText("Could not resolve one or more teacher names. Use exact names from the list.");
                                      return;
                                    }
                                    if (resolvedTeacherIds.length === 0) {
                                      return;
                                    }
                                    addTeachersToSubject(subject, resolvedTeacherIds);
                                    setTeacherSearchBySubjectEntity((prev) => ({
                                      ...prev,
                                      [searchKey]: "",
                                    }));
                                  }}
                                  placeholder="Search teacher(s), comma-separated"
                                />
                              </div>
                              <datalist id={`faggrupper-teacher-options-${activeFaggruppeClassId}-${subject.id}`}>
                                {filterTeachersForQuery(teacherDraft).map((teacher) => (
                                  <option key={teacher.id} value={teacher.name} />
                                ))}
                              </datalist>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <p>Select a class to manage subject teachers.</p>
              )}
            </section>
          </div>
        </article>
      </section>
      )}

      {activeTab === "blocks" && (
      <section className="grid">
        <article className="card">
          <h2>Blokker</h2>
          <p>Define program blocks (e.g. Blokk 1, 2, 3) with their scheduled times, participating classes, and subjects.</p>
          <form noValidate onSubmit={(e) => { e.preventDefault(); upsertBlock(); }}>
            <label>Block Name</label>
            <input
              value={blockForm.name}
              onChange={(e) => setBlockForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="Blokk 1"
            />

            <label style={{ marginTop: "12px" }}>Times</label>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "6px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "0.75em", color: "#666" }}>Day</span>
                <select
                  value={blockOccForm.day}
                  onChange={(e) => setBlockOccForm((s) => ({ ...s, day: e.target.value }))}
                  style={{ fontSize: "0.86em" }}
                >
                  {calendarDays.map((day) => (
                    <option key={day} value={day}>{day}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "0.75em", color: "#666" }}>Start</span>
                <input
                  type="text"
                  value={blockOccForm.start_time}
                  onChange={(e) => setBlockOccForm((s) => ({ ...s, start_time: normalizeTime24(e.target.value) }))}
                  onBlur={(e) => setBlockOccForm((s) => ({ ...s, start_time: normalizeTime24(e.target.value) }))}
                  inputMode="numeric"
                  placeholder="HH:MM"
                  pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
                  style={{ fontSize: "0.86em", width: "105px" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "0.75em", color: "#666" }}>End</span>
                <input
                  type="text"
                  value={blockOccForm.end_time}
                  onChange={(e) => setBlockOccForm((s) => ({ ...s, end_time: normalizeTime24(e.target.value) }))}
                  onBlur={(e) => setBlockOccForm((s) => ({ ...s, end_time: normalizeTime24(e.target.value) }))}
                  inputMode="numeric"
                  placeholder="HH:MM"
                  pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
                  style={{ fontSize: "0.86em", width: "105px" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "0.75em", color: "#666" }}>Week</span>
                <select
                  value={blockOccForm.week_type}
                  onChange={(e) => setBlockOccForm((s) => ({ ...s, week_type: parseWeekView(e.target.value) }))}
                  style={{ fontSize: "0.86em" }}
                >
                  <option value="both">Both</option>
                  <option value="A">A week</option>
                  <option value="B">B week</option>
                </select>
              </div>
              <button
                type="button"
                onClick={addOccurrenceToBlockForm}
                disabled={!isValidTime24(blockOccForm.start_time) || !isValidTime24(blockOccForm.end_time)}
                style={{ padding: "4px 10px", fontSize: "0.85em", whiteSpace: "nowrap" }}
              >
                + Add Time
              </button>
            </div>
            {blockForm.occurrences.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px" }}>
                {blockForm.occurrences.map((occ) => (
                  <div key={occ.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f5f5f5", padding: "4px 8px", borderRadius: "4px", fontSize: "0.85em" }}>
                    <span>{occ.day} {occ.start_time}–{occ.end_time} · {occ.week_type === "both" ? "Both weeks" : occ.week_type + " week"}</span>
                    <button type="button" className="secondary" onClick={() => removeOccurrenceFromBlockForm(occ.id)} style={{ padding: "2px 6px", fontSize: "0.78em", color: "#c53" }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <label style={{ marginTop: "8px" }}>Classes (who can pick subjects from this block)</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "8px" }}>
              {sortedClasses.length === 0 ? (
                <span style={{ fontSize: "0.85em", color: "#999" }}>No classes added yet.</span>
              ) : (
                sortedClasses.map((cls) => (
                  <button
                    key={cls.id}
                    type="button"
                    onClick={() => toggleBlockClass(cls.id)}
                    style={{
                      padding: "3px 10px",
                      fontSize: "0.82em",
                      borderRadius: "12px",
                      border: "1px solid",
                      borderColor: blockForm.class_ids.includes(cls.id) ? "#2a9d8f" : "#ccc",
                      background: blockForm.class_ids.includes(cls.id) ? "#2a9d8f" : "#fff",
                      color: blockForm.class_ids.includes(cls.id) ? "#fff" : "#333",
                      cursor: "pointer",
                    }}
                  >
                    {cls.name}
                  </button>
                ))
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button type="submit">{editingBlockId ? "Update Block" : "Add Block"}</button>
              {editingBlockId && (
                <button type="button" className="secondary" onClick={resetBlockForm}>Cancel</button>
              )}
            </div>
          </form>
        </article>

        <article className="card">
          <h2>Block List</h2>
          {blocks.length === 0 ? (
            <p style={{ color: "#999" }}>No blocks added yet.</p>
          ) : (
            <div className="list" style={{ maxHeight: "600px" }}>
              {blocks.map((block) => {
                const classNames = (block.class_ids ?? []).map((id) => classes.find((c) => c.id === id)?.name ?? id).join(", ");
                const isExpanded = expandedBlockId === block.id;
                const isDimmed = expandedBlockId !== null && expandedBlockId !== block.id;
                const subjectEntries = block.subject_entries ?? [];
                return (
                  <div
                    key={block.id}
                    className={`item block-list-item${isExpanded ? " is-expanded" : ""}${isDimmed ? " is-dimmed" : ""}`}
                    style={{ display: "flex", flexDirection: "column", gap: "4px" }}
                    onClick={() => handleBlockCardClick(block.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong>{block.name}</strong>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button type="button" className="secondary" onClick={(e) => { e.stopPropagation(); loadBlockIntoForm(block); }} style={{ padding: "3px 8px", fontSize: "0.75em" }}>Edit</button>
                        <button type="button" className="secondary" onClick={(e) => { e.stopPropagation(); deleteBlock(block.id); }} style={{ padding: "3px 8px", fontSize: "0.75em", color: "#c53" }}>Delete</button>
                      </div>
                    </div>
                    {(block.occurrences ?? []).length > 0 && (
                      <div style={{ fontSize: "0.82em", color: "#555", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                        {block.occurrences.map((occ) => (
                          <span key={occ.id} style={{ background: "#e8f4f8", padding: "1px 6px", borderRadius: "3px" }}>
                            {occ.day} {occ.start_time}–{occ.end_time}{occ.week_type !== "both" ? ` (${occ.week_type})` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                    {classNames && <div style={{ fontSize: "0.82em", color: "#666" }}>Classes: {classNames}</div>}
                    <div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedBlockId((prev) => prev === block.id ? null : block.id);
                        }}
                        style={{ fontSize: "0.8em", padding: "2px 8px", width: "100%", textAlign: "left" }}
                      >
                        {isExpanded ? "▲ Hide" : `▼ Subjects (${subjectEntries.length})`}
                      </button>
                      {isExpanded && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" }}>
                          {subjectEntries.map((se) => {
                            const subj = subjects.find((s) => s.id === se.subject_id);
                            const searchKey = `block_${block.id}_${se.subject_id}`;
                            return (
                              <div key={se.subject_id} className="subject-teacher-row block-subject-row" style={{ background: "#fafafa", borderRadius: "4px", padding: "4px 8px" }}>
                                <span className="subject-teacher-classname" style={{ fontSize: "0.85em", fontWeight: 600 }}>
                                  {subj?.name ?? se.subject_id}
                                </span>
                                <div className="block-subject-row-controls">
                                  <div className="faggrupper-teacher-picker block-subject-teacher-picker">
                                    <input
                                      className="block-subject-teacher-input"
                                      list={`block-teacher-opts-${block.id}-${se.subject_id}`}
                                      value={getTeacherInputValue(searchKey, se.teacher_id)}
                                      onChange={(e) => {
                                        const nextValue = e.target.value;
                                        setTeacherSearchBySubjectEntity((prev) => ({ ...prev, [searchKey]: nextValue }));
                                        const resolvedId = resolveTeacherIdFromInput(nextValue);
                                        if (resolvedId !== null) {
                                          updateBlockSubjectEntry(block.id, se.subject_id, { teacher_id: resolvedId });
                                        }
                                      }}
                                      placeholder="Assign teacher"
                                      style={{ fontSize: "0.85em" }}
                                    />
                                    <datalist id={`block-teacher-opts-${block.id}-${se.subject_id}`}>
                                      {filterTeachersForQuery(teacherSearchBySubjectEntity[searchKey] ?? "").map((t) => (
                                        <option key={t.id} value={t.name} />
                                      ))}
                                    </datalist>
                                  </div>
                                  <button
                                    type="button"
                                    className="secondary block-subject-remove-btn"
                                    onClick={() => {
                                      setBlocks((prev) => prev.map((b) =>
                                        b.id !== block.id ? b : { ...b, subject_entries: b.subject_entries.filter((s) => s.subject_id !== se.subject_id) }
                                      ));
                                    }}
                                    style={{ color: "#c53" }}
                                  >✕</button>
                                </div>
                              </div>
                            );
                          })}
                          <div className="block-subject-add-row">
                            <input
                              className="block-subject-add-input"
                              type="text"
                              placeholder="New subject name"
                              value={blockInlineSubjNames[block.id] ?? ""}
                              onChange={(e) => setBlockInlineSubjNames((prev) => ({ ...prev, [block.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createAndAddSubjectToSavedBlock(block.id); } }}
                              style={{ fontSize: "0.84em", padding: "3px 6px", border: "1px solid #ccc" }}
                            />
                            <button
                              type="button"
                              className="block-subject-add-btn"
                              onClick={() => createAndAddSubjectToSavedBlock(block.id)}
                              disabled={!(blockInlineSubjNames[block.id] ?? "").trim()}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              + Add
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </article>
      </section>
      )}

      {activeTab === "meetings" && (
      <section className="grid">
        <article className="card">
          <h2>Møter</h2>
          <p>Add permanent meetings that reserve teacher time. Cycle teachers between available, preferred busy, and blocked.</p>

          {!timeslots.length ? (
            <p>Add timeslots in Week Calendar before creating meetings.</p>
          ) : !teachers.length ? (
            <p>Add teachers before assigning them to a meeting.</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); upsertMeeting(); }}>
              <label>Meeting Name</label>
              <input
                value={meetingForm.name}
                onChange={(e) => setMeetingForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Team meeting, mentor hour, department meeting"
              />

              <label>Timeslot</label>
              <select
                value={meetingForm.timeslot_id}
                onChange={(e) => setMeetingForm((prev) => ({ ...prev, timeslot_id: e.target.value }))}
              >
                {sortedTimeslots.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.day} {slot.start_time}-{slot.end_time} ({slot.id})
                  </option>
                ))}
              </select>

              <div className="meeting-legend">
                <span className="meeting-badge available">Available</span>
                <span className="meeting-badge preferred">Prefer busy</span>
                <span className="meeting-badge unavailable">Busy</span>
              </div>

              <label>Teachers</label>
              <div className="meeting-filter-row">
                <input
                  value={meetingTeacherSearchQuery}
                  onChange={(e) => setMeetingTeacherSearchQuery(e.target.value)}
                  placeholder="Search teachers"
                />
                <select
                  value={meetingAvdelingFilter}
                  onChange={(e) => setMeetingAvdelingFilter(e.target.value)}
                >
                  <option value="all">All avdelinger</option>
                  {availableAvdelinger.map((avdeling) => (
                    <option key={avdeling} value={avdeling}>{avdeling}</option>
                  ))}
                </select>
              </div>

              <div className="meeting-bulk-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => applyMeetingTeacherModeToVisible("unavailable")}
                  disabled={filteredMeetingTeachers.length === 0}
                >
                  Select All Busy
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => applyMeetingTeacherModeToVisible("preferred")}
                  disabled={filteredMeetingTeachers.length === 0}
                >
                  Select All Prefer Busy
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => applyMeetingTeacherModeToVisible(null)}
                  disabled={filteredMeetingTeachers.length === 0}
                >
                  Clear Visible
                </button>
              </div>

              <div className="meeting-teacher-list">
                {filteredMeetingTeachers.map((teacher) => {
                  const mode = meetingForm.teacher_modes[teacher.id];
                  return (
                    <button
                      key={teacher.id}
                      type="button"
                      className={`meeting-teacher-toggle ${mode ?? "available"}`}
                      onClick={() => cycleMeetingTeacherMode(teacher.id)}
                    >
                      {teacher.name}{teacher.avdeling ? ` (${teacher.avdeling})` : ""}
                    </button>
                  );
                })}
                {filteredMeetingTeachers.length === 0 ? (
                  <p className="meeting-empty">No teachers match the current search.</p>
                ) : null}
              </div>

              <div className="meeting-actions-row">
                <button type="submit">{editingMeetingId ? "Update Meeting" : "Add Meeting"}</button>
                <button type="button" className="secondary" onClick={resetMeetingForm}>
                  {editingMeetingId ? "Cancel Edit" : "Reset"}
                </button>
              </div>
            </form>
          )}
        </article>

        <article className="card">
          <h2>Permanent Meeting List</h2>
          <p>These meetings are always rendered on the schedule and are sent to the solver as hard or soft teacher constraints.</p>

          <div className="list meeting-list">
            {sortedMeetings.length === 0 ? (
              <p className="meeting-empty">No meetings created yet.</p>
            ) : (
              sortedMeetings.map((meeting) => {
                const slot = timeslotById[meeting.timeslot_id];
                const preferredTeachers = meeting.teacher_assignments
                  .filter((assignment) => assignment.mode === "preferred")
                  .map((assignment) => teacherNameById[assignment.teacher_id] ?? assignment.teacher_id);
                const unavailableTeachers = meeting.teacher_assignments
                  .filter((assignment) => assignment.mode === "unavailable")
                  .map((assignment) => teacherNameById[assignment.teacher_id] ?? assignment.teacher_id);

                const isExpanded = expandedMeetings.has(meeting.id);
                const totalAssigned = meeting.teacher_assignments.length;
                return (
                  <div key={meeting.id} className="meeting-item">
                    <div className="meeting-item-header">
                      <div>
                        <strong>{meeting.name}</strong>
                        <p>
                          {slot ? `${slot.day} ${slot.start_time}-${slot.end_time}` : meeting.timeslot_id}
                        </p>
                      </div>
                      <div className="meeting-item-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setExpandedMeetings((prev) => {
                            const next = new Set(prev);
                            if (next.has(meeting.id)) next.delete(meeting.id); else next.add(meeting.id);
                            return next;
                          })}
                        >
                          {isExpanded ? "▲ Hide" : `▼ Show (${totalAssigned})`}
                        </button>
                        <button type="button" className="secondary" onClick={() => loadMeetingIntoForm(meeting)}>
                          Edit
                        </button>
                        <button type="button" className="secondary" onClick={() => deleteMeeting(meeting.id)}>
                          Delete
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                    <div className="meeting-summary-grid">
                      <div>
                        <span className="meeting-summary-label">Busy</span>
                        <div className="meeting-chip-row">
                          {unavailableTeachers.length ? unavailableTeachers.map((name) => (
                            <span key={`${meeting.id}_${name}_busy`} className="meeting-chip unavailable">{name}</span>
                          )) : <span className="meeting-chip neutral">None</span>}
                        </div>
                      </div>
                      <div>
                        <span className="meeting-summary-label">Prefer Busy</span>
                        <div className="meeting-chip-row">
                          {preferredTeachers.length ? preferredTeachers.map((name) => (
                            <span key={`${meeting.id}_${name}_pref`} className="meeting-chip preferred">{name}</span>
                          )) : <span className="meeting-chip neutral">None</span>}
                        </div>
                      </div>
                    </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </article>
      </section>
      )}

      {activeTab === "rom" && (
      <section className="grid">
        <article className="card">
          <h2>Rooms (Rom)</h2>
          <p>Add rooms and assign a base room to each class for their common subjects (fellesfag).</p>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px", marginBottom: "12px", alignItems: "end" }}>
            <input
              type="text"
              placeholder="Room name(s) - separate multiple with commas (e.g., R202, R203, R204)"
              value={roomForm.name}
              onChange={(e) => setRoomForm({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") upsertRoom(); }}
              style={{ fontSize: "0.86em", padding: "6px 8px", border: "1px solid #ccc" }}
            />
            <button
              type="button"
              onClick={() => {
                upsertRoom();
              }}
              style={{ padding: "6px 12px", whiteSpace: "nowrap" }}
            >
              {editingRoomId ? "Update Room" : "Add Room"}
            </button>
            {editingRoomId && (
              <button
                type="button"
                onClick={() => {
                  setRoomForm({ name: "" });
                  setEditingRoomId(null);
                }}
                className="secondary"
                style={{ gridColumn: "2", padding: "6px 12px", whiteSpace: "nowrap" }}
              >
                Cancel
              </button>
            )}
          </div>

          <div className="list" style={{ maxHeight: "150px" }}>
            {sortedRooms.length === 0 ? (
              <p className="meeting-empty">No rooms added yet.</p>
            ) : (
              sortedRooms.map((room) => (
                <div key={room.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px", borderBottom: "1px solid #eee" }}>
                  <span>{room.name}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => loadRoomIntoForm(room)}
                      style={{ padding: "4px 8px", fontSize: "0.75em" }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => deleteRoom(room.id)}
                      style={{ padding: "4px 8px", fontSize: "0.75em", color: "#c53" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <h3 style={{ marginTop: "16px" }}>Base Room per Class</h3>
          <p style={{ fontSize: "0.85em", color: "#666" }}>Assign a base room for each class, which will be used for their fellesfag (common subjects).</p>
          <div style={{ display: "grid", gap: "12px" }}>
            {sortedClasses.map((cls) => (
              <div key={cls.id} style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "8px", alignItems: "center", padding: "8px", border: "1px solid #ddd", borderRadius: "4px" }}>
                <label style={{ fontWeight: 500, fontSize: "0.9em" }}>{cls.name}</label>
                <select
                  value={cls.base_room_id ?? ""}
                  onChange={(e) => {
                    const newRoomId = e.target.value || undefined;
                    if (newRoomId) {
                      // Check if room is already assigned to another class
                      const isAssignedElsewhere = classes.some((c) => c.id !== cls.id && c.base_room_id === newRoomId);
                      if (isAssignedElsewhere) {
                        setStatusText("This room is already assigned to another class.");
                        return;
                      }
                    }
                    setClasses((prev) => prev.map((c) => (
                      c.id === cls.id
                        ? { ...c, base_room_id: newRoomId }
                        : c
                    )));
                  }}
                  style={{ padding: "6px 8px", fontSize: "0.86em", border: cls.base_room_id ? "1px solid #ccc" : "2px solid #f88", borderRadius: "3px" }}
                >
                  <option value="">— No room assigned —</option>
                  {sortedRooms.map((room) => {
                    const isCurrentlyAssigned = cls.base_room_id === room.id;
                    const isAssignedElsewhere = roomsAssignedToClasses.has(room.id) && !isCurrentlyAssigned;
                    return (
                      <option key={room.id} value={room.id} disabled={isAssignedElsewhere}>
                        {room.name}{isAssignedElsewhere ? " (assigned)" : ""}
                      </option>
                    );
                  })}
                </select>
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

          <div style={{ marginBottom: "15px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontSize: "0.9em" }}>Import Teachers from Excel</label>
            <div
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              style={{
                border: "2px dashed #0066cc",
                borderRadius: "6px",
                padding: "12px 15px",
                textAlign: "center",
                backgroundColor: "#f0f7ff",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
              onClick={() => excelFileRef.current?.click()}
            >
              <input
                ref={excelFileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleExcelUpload}
                style={{ display: "none" }}
              />
              <div style={{ fontSize: "0.95em", fontWeight: "bold", color: "#0066cc", marginBottom: "4px" }}>
                📁 Drag and drop your Excel file here
              </div>
              <div style={{ fontSize: "0.8em", color: "#666" }}>
                or <span style={{ textDecoration: "underline", cursor: "pointer" }}>click to browse</span>
              </div>
              <p style={{ fontSize: "0.75em", color: "#666", marginTop: "4px" }}>
                Supports Fornavn/Etternavn or Name/Teacher columns (.xlsx, .xls, .csv)
              </p>
            </div>
          </div>

          <hr style={{ margin: "12px 0" }} />

          <form onSubmit={(e) => { e.preventDefault(); addTeacher(); }} style={{ marginBottom: "12px" }}>
            <label>Add Teacher Manually</label>
            <input value={teacherForm.name} onChange={(e) => setTeacherForm((s) => ({ ...s, name: e.target.value }))} placeholder="Teacher name" />
            <label>Workload (%)</label>
            <input
              type="number"
              min={1}
              max={100}
              value={teacherForm.workload_percent}
              onChange={(e) => setTeacherForm((s) => ({ ...s, workload_percent: e.target.value }))}
              placeholder="100"
            />
            <button type="submit">Add Teacher</button>
          </form>

          <div style={{ marginTop: "12px", height: "600px", display: "flex", flexDirection: "column" }}>
            <h3 style={{ margin: "0 0 8px 0", fontSize: "1em" }}>Teachers List</h3>
            {teachers.length === 0 ? (
              <p style={{ color: "#999", fontSize: "0.9em" }}>No teachers added yet.</p>
            ) : (
              <>
                <input
                  value={teacherSearchQuery}
                  onChange={(e) => setTeacherSearchQuery(e.target.value)}
                  placeholder="Search teachers (any order)"
                  style={{ marginBottom: "8px", fontSize: "0.86em" }}
                />
                <div className="list" style={{ flex: 1, overflowY: "auto", border: "1px solid #ddd", borderRadius: "4px", maxHeight: "none", marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                {filteredTeachers.length === 0 ? (
                  <p style={{ color: "#999", fontSize: "0.86em", padding: "8px" }}>
                    No matches for &quot;{teacherSearchQuery}&quot;.
                  </p>
                ) : (
                filteredTeachers.map((t) => (
                  <div key={t.id} style={{ marginBottom: "5px", border: "1px solid #eee", borderRadius: "3px", backgroundColor: "#fff" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 8px",
                        cursor: "pointer",
                        backgroundColor: expandedTeacherId === t.id ? "#f0f0f0" : "#fff",
                                              fontSize: "0.9em",
                      }}
                      onClick={() => setExpandedTeacherId(expandedTeacherId === t.id ? null : t.id)}
                    >
                      <span style={{ fontWeight: "bold", flex: 1 }}>{t.name}</span>
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", marginLeft: "8px" }}>
                        <span style={{ fontSize: "0.85em", color: "#666" }}>
                          {t.workload_percent}% workload, {t.preferred_avoid_timeslots.length} pref, {t.unavailable_timeslots.length} blocked
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteTeacher(t.id);
                          }}
                          style={{
                            padding: "2px 6px",
                            backgroundColor: "#ff6b6b",
                            color: "white",
                            border: "none",
                            borderRadius: "3px",
                            cursor: "pointer",
                            fontSize: "0.7em",
                          }}
                        >
                          Delete
                        </button>
                        <span style={{ fontSize: "0.9em" }}>
                          {expandedTeacherId === t.id ? "▼" : "▶"}
                        </span>
                      </div>
                    </div>

                    {expandedTeacherId === t.id && (
                      <div style={{ padding: "8px", backgroundColor: "#fafafa", borderTop: "1px solid #eee" }}>
                        <div style={{ marginBottom: "8px", display: "grid", gridTemplateColumns: "1fr auto", gap: "8px", alignItems: "center" }}>
                          <label style={{ fontSize: "0.85em", fontWeight: 600 }}>Workload percentage</label>
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={t.workload_percent}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const nextValue = Math.min(100, Math.max(1, Number.parseInt(e.target.value, 10) || 100));
                              setTeachers((prev) => prev.map((teacher) => (
                                teacher.id === t.id
                                  ? { ...teacher, workload_percent: nextValue }
                                  : teacher
                              )));
                            }}
                            style={{ width: "88px" }}
                            aria-label={`${t.name} workload percent`}
                          />
                        </div>
                        <h4 style={{ margin: "0 0 6px 0", fontSize: "0.85em" }}>Click to cycle: Available -&gt; Preferred (orange) -&gt; Blocked (red)</h4>
                        {(() => {
                          const slotsByDay: Record<string, Timeslot[]> = Object.fromEntries(
                            calendarDays.map((day) => [
                              day,
                              timeslots
                                .filter((ts) => ts.day === day)
                                .sort((a, b) => {
                                  const timeCmp = toMinutes(a.start_time) - toMinutes(b.start_time);
                                  return timeCmp !== 0 ? timeCmp : a.period - b.period;
                                }),
                            ])
                          );
                          const maxRows = Math.max(0, ...calendarDays.map((day) => slotsByDay[day].length));
                          const rowIndexes = Array.from({ length: maxRows }, (_, idx) => idx);

                          return (
                            <div style={{ marginTop: "6px", border: "1px solid #bdbdb8", backgroundColor: "#f2f2f0" }}>
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: `repeat(${calendarDays.length}, minmax(100px, 1fr))`,
                                  borderBottom: "1px solid #8f8f8c",
                                }}
                              >
                                {calendarDays.map((day) => (
                                  <div
                                    key={day}
                                    style={{
                                      padding: "4px",
                                      textAlign: "center",
                                      fontSize: "0.75em",
                                      fontWeight: 700,
                                      letterSpacing: "0.06em",
                                      color: "#3f3f3c",
                                      borderRight: "1px solid #8f8f8c",
                                      background: "#e7e6e1",
                                    }}
                                  >
                                    {day.toUpperCase()}
                                  </div>
                                ))}
                              </div>

                              <div>
                                {rowIndexes.map((rowIdx) => (
                                  <div
                                    key={`row_${rowIdx}`}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: `repeat(${calendarDays.length}, minmax(100px, 1fr))`,
                                      borderBottom: rowIdx === rowIndexes.length - 1 ? "none" : "1px solid #d3d3ce",
                                    }}
                                  >
                                    {calendarDays.map((day) => {
                                      const ts = slotsByDay[day][rowIdx];
                                      if (!ts) {
                                        return (
                                          <div
                                            key={`${day}_${rowIdx}_empty`}
                                            style={{ minHeight: "30px", borderRight: "1px solid #c9c9c4", backgroundColor: "#f7f7f5" }}
                                          />
                                        );
                                      }
                                      const isUnavailable = t.unavailable_timeslots.includes(ts.id);
                                      const isPreferred = t.preferred_avoid_timeslots.includes(ts.id);
                                      const timeLabel = ts.start_time && ts.end_time
                                        ? `${ts.start_time} - ${ts.end_time}`
                                        : `Period ${ts.period}`;

                                      return (
                                        <button
                                          key={ts.id}
                                          type="button"
                                          onClick={() => toggleTeacherTimeslot(t.id, ts.id)}
                                          style={{
                                            minHeight: "30px",
                                            padding: "5px 4px",
                                            backgroundColor: isUnavailable ? "#ff6b6b" : isPreferred ? "#f2a53a" : "#fff",
                                            color: (isUnavailable || isPreferred) ? "white" : "#333",
                                            textAlign: "center",
                                            cursor: "pointer",
                                            userSelect: "none",
                                            fontSize: "0.72em",
                                            fontWeight: (isUnavailable || isPreferred) ? "bold" : "normal",
                                            border: "none",
                                            borderRight: "1px solid #c9c9c4",
                                            transition: "all 0.2s",
                                          }}
                                          title={`${isUnavailable ? "Blocked" : isPreferred ? "Preferred to avoid" : "Available"} - Period ${ts.period}${ts.start_time && ts.end_time ? ` (${ts.start_time}-${ts.end_time})` : ""}`}
                                        >
                                          {timeLabel}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))
                )}
                </div>
              </>
            )}
          </div>
        </article>
      </section>
      )}

      {activeTab === "generate" && (
      <>
        <section className="card week-strategy">
          <h2>Scheduling Mode</h2>
        </section>

        <section className="toolbar">
          <button type="button" onClick={generateSchedule} disabled={loading}>
            {loading ? "Generating..." : "Generate Schedule"}
          </button>
          <button
            type="button"
            onClick={clearGeneratedSchedule}
            disabled={loading || schedule.length === 0}
          >
            Clear Generated Schedule
          </button>
          <div className="status">{statusText}</div>
        </section>

        <section className="card">
          <h2>Schedule Timeline</h2>
          <div className="compare-controls">
            <div className="compare-group">
              <label>Compare classes</label>
              <input
                type="text"
                value={compareClassSearchQuery}
                onChange={(e) => setCompareClassSearchQuery(e.target.value)}
                placeholder="Search classes"
              />
              <select
                multiple
                value={selectedClassCompareIds}
                onMouseDown={(e) => {
                  const target = e.target as HTMLOptionElement;
                  if (target.tagName !== "OPTION") {
                    return;
                  }
                  e.preventDefault();
                  const value = target.value;
                  setSelectedClassCompareIds((prev) => (
                    prev.includes(value)
                      ? prev.filter((id) => id !== value)
                      : [...prev, value]
                  ));
                }}
                onChange={() => {}}
              >
                {filteredCompareClasses.map((schoolClass) => (
                  <option key={schoolClass.id} value={schoolClass.id}>{schoolClass.name}</option>
                ))}
              </select>
            </div>
            <div className="compare-group">
              <label>Compare teachers</label>
              <input
                type="text"
                value={compareTeacherSearchQuery}
                onChange={(e) => setCompareTeacherSearchQuery(e.target.value)}
                placeholder="Search teachers"
              />
              <select
                multiple
                value={selectedTeacherCompareIds}
                onMouseDown={(e) => {
                  const target = e.target as HTMLOptionElement;
                  if (target.tagName !== "OPTION") {
                    return;
                  }
                  e.preventDefault();
                  const value = target.value;
                  setSelectedTeacherCompareIds((prev) => (
                    prev.includes(value)
                      ? prev.filter((id) => id !== value)
                      : [...prev, value]
                  ));
                }}
                onChange={() => {}}
              >
                {filteredCompareTeachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>{teacher.name}</option>
                ))}
              </select>
            </div>
            <div className="compare-group">
              <label>Compare rooms</label>
              <input
                type="text"
                value={compareRoomSearchQuery}
                onChange={(e) => setCompareRoomSearchQuery(e.target.value)}
                placeholder="Search rooms"
              />
              <select
                multiple
                value={selectedRoomCompareIds}
                onMouseDown={(e) => {
                  const target = e.target as HTMLOptionElement;
                  if (target.tagName !== "OPTION") {
                    return;
                  }
                  e.preventDefault();
                  const value = target.value;
                  setSelectedRoomCompareIds((prev) => (
                    prev.includes(value)
                      ? prev.filter((id) => id !== value)
                      : [...prev, value]
                  ));
                }}
                onChange={() => {}}
              >
                {filteredCompareRooms.map((room) => (
                  <option key={room.id} value={room.id}>{room.name}</option>
                ))}
              </select>
            </div>
            <div className="compare-actions">
              <div className="compare-week-view">
                <label>Display</label>
                <select
                  value={weekView}
                  onChange={(e) => setWeekView(parseWeekView(e.target.value))}
                >
                  <option value="both">Show both weeks</option>
                  <option value="A">Show A-week only</option>
                  <option value="B">Show B-week only</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedClassCompareIds([]);
                  setSelectedTeacherCompareIds([]);
                  setSelectedRoomCompareIds([]);
                }}
                disabled={selectedClassCompareIds.length === 0 && selectedTeacherCompareIds.length === 0 && selectedRoomCompareIds.length === 0}
              >
                Clear compare
              </button>
            </div>
          </div>
          {compareEntities.length > 0 ? (
            <div className="compare-legend">
              {compareEntities.map((entity) => (
                <span key={entity.id} className="compare-pill" style={{ borderColor: entity.color }}>
                  <span className="dot" style={{ backgroundColor: entity.color }} />
                  {entity.kind === "class" ? "Class" : entity.kind === "teacher" ? "Teacher" : "Room"}: {entity.label}
                  <button
                    type="button"
                    className="compare-pill-remove"
                    aria-label={`Remove ${entity.kind} ${entity.label} from comparison`}
                    onClick={() => {
                      const rawId = entity.id.split(":")[1] ?? "";
                      if (entity.kind === "class") {
                        setSelectedClassCompareIds((prev) => prev.filter((id) => id !== rawId));
                        return;
                      }
                      if (entity.kind === "teacher") {
                        setSelectedTeacherCompareIds((prev) => prev.filter((id) => id !== rawId));
                        return;
                      }
                      setSelectedRoomCompareIds((prev) => prev.filter((id) => id !== rawId));
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : null}
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

                    {(() => {
                      type RenderEvent = {
                        key: string;
                        kind: "subject" | "meeting";
                        subjectId?: string;
                        title: string;
                        weekType?: "A" | "B";
                        isBlockSubject?: boolean;
                        isBlockSummary?: boolean;
                        blockSummaryKey?: string;
                        ts: Timeslot | undefined;
                        classLabel: string;
                        teacherLabel: string;
                        roomLabel?: string;
                        laneIndex: number;
                        laneCount: number;
                        laneEntityLabel: string;
                        laneEntityKind?: "class" | "teacher" | "room";
                        laneColor: string;
                        topPct: number;
                        heightPct: number;
                        displayStart: string;
                        displayEnd: string;
                        startMin: number;
                        endMin: number;
                        overlapCol: number;
                        overlapCols: number;
                        fillColor?: string;
                      };

                        const subjectEventsRaw: RenderEvent[] = displaySchedule
                          .filter((item) => item.day === day)
                          .filter((item) => {
                            if (!enableAlternatingWeeks || weekView === "both") {
                              return true;
                            }
                            return !item.week_type || item.week_type === weekView;
                          })
                          .flatMap((item) => {
                            const ts = timeslotById[item.timeslot_id];
                            const start = toMinutes(item.start_time ?? ts?.start_time);
                            const end = toMinutes(item.end_time ?? ts?.end_time);
                            if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER) {
                              return [] as RenderEvent[];
                            }

                            const clampedStart = Math.max(DAY_START_MINUTES, start);
                            const clampedEnd = Math.min(DAY_END_MINUTES, end);
                            if (clampedEnd <= clampedStart) {
                              return [] as RenderEvent[];
                            }

                            const topPct = ((clampedStart - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                            const heightPct = ((clampedEnd - clampedStart) / TIMELINE_TOTAL_MINUTES) * 100;
                            const classLabel = item.class_ids.map((id) => classNameById[id] ?? id).join(", ");
                            const teacherIds = Array.from(new Set([
                              ...(item.teacher_id ? [item.teacher_id] : []),
                              ...(item.teacher_ids ?? []),
                            ].filter(Boolean)));
                            const teacherLabel = teacherIds
                              .map((teacherId) => teacherNameById[teacherId] ?? teacherId)
                              .join(", ");
                            const roomLabel = item.room_id ? rooms.find((r) => r.id === item.room_id)?.name : undefined;
                            const blockInfo = subjectToBlockInfo.get(item.subject_id);
                            const blockClassIds = blockInfo?.class_ids ?? [];

                            const matchedEntityIds = compareEntities.length
                              ? [
                                  ...item.class_ids
                                    .filter((id) => selectedClassCompareIds.includes(id))
                                    .map((id) => `class:${id}`),
                                  ...blockClassIds
                                    .filter((id) => selectedClassCompareIds.includes(id) && !item.class_ids.includes(id))
                                    .map((id) => `class:${id}`),
                                  ...(selectedTeacherCompareIds.includes(item.teacher_id)
                                    ? [`teacher:${item.teacher_id}`]
                                    : []),
                                  ...(item.room_id && selectedRoomCompareIds.includes(item.room_id)
                                    ? [`room:${item.room_id}`]
                                    : []),
                                ]
                              : ["all"];

                            if (matchedEntityIds.length === 0) {
                              return [] as RenderEvent[];
                            }

                            const laneCount = compareEntities.length > 0 ? compareEntities.length : 1;

                            return matchedEntityIds.map<RenderEvent>((entityId, entityRenderIndex) => {
                              const laneIndex = compareEntities.length > 0
                                ? (compareEntityIndex[entityId] ?? 0)
                                : 0;
                              const laneEntity = compareEntities[laneIndex];
                              const laneColor = laneEntity?.color ?? "#355070";
                              
                              let displayTitle = item.subject_name;
                              const isClassView = entityId.startsWith("class:");
                              if (isClassView && blockInfo) {
                                displayTitle = blockInfo.block_name;
                              }

                              const blockSummaryKey = isClassView && blockInfo
                                ? `${entityId}|${blockInfo.block_id}|${item.timeslot_id}`
                                : undefined;

                              let blockWeekTypeFromDefinition: "A" | "B" | undefined = undefined;
                              if (blockInfo) {
                                const weekKey = `${blockInfo.block_id}|${item.timeslot_id}`;
                                blockWeekTypeFromDefinition = blockWeekTypeBySlot.has(weekKey)
                                  ? blockWeekTypeBySlot.get(weekKey)
                                  : item.week_type;
                              }

                              const classLabelForRender = classLabel || blockClassIds
                                .map((id) => classNameById[id] ?? id)
                                .join(", ");
                              
                              return {
                                key: `${item.subject_id}_${item.timeslot_id}_${item.week_type ?? "base"}_${classLabel}_${entityId}_${entityRenderIndex}`,
                                kind: "subject",
                                subjectId: item.subject_id,
                                title: displayTitle,
                                weekType: blockInfo ? blockWeekTypeFromDefinition : item.week_type,
                                isBlockSubject: Boolean(blockInfo),
                                isBlockSummary: Boolean(blockSummaryKey),
                                blockSummaryKey,
                                ts,
                                classLabel: classLabelForRender,
                                teacherLabel,
                                roomLabel,
                                laneIndex,
                                laneCount,
                                laneEntityLabel: laneEntity?.label ?? "Selection",
                                laneEntityKind: laneEntity?.kind,
                                laneColor,
                                topPct,
                                heightPct,
                                displayStart: item.start_time ?? ts?.start_time ?? "",
                                displayEnd: item.end_time ?? ts?.end_time ?? "",
                                startMin: clampedStart,
                                endMin: clampedEnd,
                                overlapCol: 0,
                                overlapCols: 1,
                                fillColor: compareEntities.length > 0 ? toOpaqueTint(laneColor) : undefined,
                              };
                            });
                          });

                      const subjectEvents: RenderEvent[] = (() => {
                        const merged: RenderEvent[] = [];
                        const blockSummaryIndex = new Map<string, number>();

                        for (const event of subjectEventsRaw) {
                          if (!event.blockSummaryKey) {
                            merged.push(event);
                            continue;
                          }

                          if (blockSummaryIndex.has(event.blockSummaryKey)) {
                            continue;
                          }

                          blockSummaryIndex.set(event.blockSummaryKey, merged.length);
                          merged.push({
                            ...event,
                            teacherLabel: "",
                            classLabel: "",
                            roomLabel: undefined,
                          });
                        }

                        return merged;
                      })();

                      const meetingEvents: RenderEvent[] = meetings
                          .filter((meeting) => timeslotById[meeting.timeslot_id]?.day === day)
                          .flatMap((meeting) => {
                            const ts = timeslotById[meeting.timeslot_id];
                            const start = toMinutes(ts?.start_time);
                            const end = toMinutes(ts?.end_time);
                            if (start === Number.MAX_SAFE_INTEGER || end === Number.MAX_SAFE_INTEGER) {
                              return [] as RenderEvent[];
                            }

                            const clampedStart = Math.max(DAY_START_MINUTES, start);
                            const clampedEnd = Math.min(DAY_END_MINUTES, end);
                            if (clampedEnd <= clampedStart) {
                              return [] as RenderEvent[];
                            }

                            const topPct = ((clampedStart - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                            const heightPct = ((clampedEnd - clampedStart) / TIMELINE_TOTAL_MINUTES) * 100;
                            const teacherIds = meeting.teacher_assignments.map((assignment) => assignment.teacher_id);
                            const teacherLabel = teacherIds
                              .map((teacherId) => teacherNameById[teacherId] ?? teacherId)
                              .join(", ");

                            const matchedEntityIds = compareEntities.length
                              ? Array.from(new Set(
                                  teacherIds
                                    .filter((teacherId) => selectedTeacherCompareIds.includes(teacherId))
                                    .map((teacherId) => `teacher:${teacherId}`)
                                ))
                              : ["all"];

                            if (matchedEntityIds.length === 0) {
                              return [] as RenderEvent[];
                            }

                            const laneCount = compareEntities.length > 0 ? compareEntities.length : 1;

                            return matchedEntityIds.map<RenderEvent>((entityId, entityRenderIndex) => {
                              const laneIndex = compareEntities.length > 0
                                ? (compareEntityIndex[entityId] ?? 0)
                                : 0;
                              const laneEntity = compareEntities[laneIndex];
                              const laneColor = laneEntity?.color ?? "#7b6848";
                              return {
                                key: `${meeting.id}_${meeting.timeslot_id}_${entityId}_${entityRenderIndex}`,
                                kind: "meeting",
                                subjectId: undefined,
                                title: meeting.name,
                                ts,
                                classLabel: "Meeting",
                                teacherLabel,
                                laneIndex,
                                laneCount,
                                laneEntityLabel: laneEntity?.label ?? "Meeting",
                                laneEntityKind: laneEntity?.kind,
                                laneColor,
                                topPct,
                                heightPct,
                                displayStart: ts?.start_time ?? "",
                                displayEnd: ts?.end_time ?? "",
                                startMin: clampedStart,
                                endMin: clampedEnd,
                                overlapCol: 0,
                                overlapCols: 1,
                                fillColor: compareEntities.length > 0 ? toOpaqueTint(laneColor, 0.86) : "#efe7d9",
                              };
                            });
                          });

                      const baseEvents: RenderEvent[] = [...subjectEvents, ...meetingEvents];

                      const byLane = new Map<number, number[]>();
                      baseEvents.forEach((event, idx) => {
                        const list = byLane.get(event.laneIndex) ?? [];
                        list.push(idx);
                        byLane.set(event.laneIndex, list);
                      });

                      byLane.forEach((indices) => {
                        indices.sort((a, b) => {
                          const startCmp = baseEvents[a].startMin - baseEvents[b].startMin;
                          if (startCmp !== 0) {
                            return startCmp;
                          }
                          return baseEvents[a].endMin - baseEvents[b].endMin;
                        });

                        type ActiveEvent = { idx: number; endMin: number; col: number };
                        let active: ActiveEvent[] = [];
                        let clusterIndices: number[] = [];
                        let clusterMaxCols = 1;

                        const commitCluster = () => {
                          for (const eventIdx of clusterIndices) {
                            baseEvents[eventIdx].overlapCols = Math.max(1, clusterMaxCols);
                          }
                          clusterIndices = [];
                          clusterMaxCols = 1;
                        };

                        for (const eventIdx of indices) {
                          const event = baseEvents[eventIdx];

                          active = active.filter((entry) => entry.endMin > event.startMin);

                          if (active.length === 0 && clusterIndices.length > 0) {
                            commitCluster();
                          }

                          const usedCols = new Set(active.map((entry) => entry.col));
                          let nextCol = 0;
                          while (usedCols.has(nextCol)) {
                            nextCol += 1;
                          }

                          event.overlapCol = nextCol;
                          active.push({ idx: eventIdx, endMin: event.endMin, col: nextCol });
                          clusterIndices.push(eventIdx);
                          clusterMaxCols = Math.max(clusterMaxCols, active.length);
                        }

                        if (clusterIndices.length > 0) {
                          commitCluster();
                        }
                      });

                      const concurrentEventCounts = new Map<string, number>();
                      for (const event of baseEvents) {
                        const concurrentCount = baseEvents.reduce((count, candidate) => {
                          if (candidate.key === event.key) {
                            return count;
                          }
                          const overlapsInTime = candidate.startMin < event.endMin && candidate.endMin > event.startMin;
                          return overlapsInTime ? count + 1 : count;
                        }, 0);
                        concurrentEventCounts.set(event.key, concurrentCount + 1);
                      }

                      return baseEvents.map((event, eventIdx) => {
                        const laneWidth = 100 / Math.max(1, event.laneCount);
                        const laneLeft = event.laneIndex * laneWidth;
                        const overlapWidth = laneWidth / Math.max(1, event.overlapCols);
                        const overlapLeft = laneLeft + event.overlapCol * overlapWidth;
                        const canExpand = (concurrentEventCounts.get(event.key) ?? 1) > 1;
                        const isHovered = hoveredTimelineEventKey === event.key;
                        const isSubjectGroupHovered = Boolean(
                          hoveredTimelineSubjectId &&
                          event.kind === "subject" &&
                          event.subjectId === hoveredTimelineSubjectId
                        );
                        const isExpanded = canExpand && expandedTimelineEventKey === event.key;

                        const eventClassName = `weekly-event ${event.kind === "meeting" ? "meeting" : getSlotToneClass(event.ts)}${event.isBlockSubject ? " block-subject" : ""}${isHovered ? " hovered" : ""}${isSubjectGroupHovered ? " subject-group-hovered" : ""}`;

                        const shouldShowClassLine =
                          !event.isBlockSummary &&
                          Boolean(event.classLabel) &&
                          (
                            compareEntities.length === 0 ||
                            event.laneEntityKind !== "class" ||
                            event.laneEntityLabel !== event.classLabel
                          );

                        const eventBody = (
                          <>
                            <div className="weekly-event-header-row">
                              <strong>{event.title}</strong>
                              <small>{event.displayStart}-{event.displayEnd}</small>
                            </div>
                            {enableAlternatingWeeks && event.weekType ? <small>Week {event.weekType}</small> : null}
                            {!event.isBlockSummary ? (
                              <>
                                {compareEntities.length > 0 && event.laneEntityKind !== "class" ? (
                                  <small>{event.laneEntityLabel}</small>
                                ) : null}
                                {shouldShowClassLine ? (
                                  <small>{event.classLabel}</small>
                                ) : null}
                                {event.teacherLabel ? <small>{event.teacherLabel}</small> : null}
                                {event.roomLabel ? <small>Rom {event.roomLabel}</small> : null}
                              </>
                            ) : null}
                          </>
                        );

                        const baseEventBackgroundColor =
                          (event.isBlockSubject && compareEntities.length === 0 ? "#f9ebe6" : event.fillColor)
                          ?? "#e6ebf3";
                        const eventBackgroundColor =
                          event.kind === "subject" && event.isBlockSubject
                            ? darkenColor(baseEventBackgroundColor, 0.04)
                            : baseEventBackgroundColor;
                        const weekStripeOverlay = event.kind === "subject" && event.weekType
                          ? weekStripeOverlayForColor(
                              eventBackgroundColor,
                              event.weekType === "A" ? "up" : "down"
                            )
                          : undefined;

                        return (
                          <Fragment key={`${event.key}_fragment_${eventIdx}`}>
                            <article
                              key={`${event.key}_base`}
                              className={eventClassName}
                              onClick={() => {
                                if (!canExpand) {
                                  return;
                                }
                                setExpandedTimelineEventKey((current) => (current === event.key ? null : event.key));
                              }}
                              onMouseEnter={() => {
                                setHoveredTimelineEventKey(event.key);
                                setHoveredTimelineSubjectId(event.kind === "subject" ? (event.subjectId ?? null) : null);
                              }}
                              onMouseLeave={() => {
                                setHoveredTimelineEventKey((current) => (current === event.key ? null : current));
                                setHoveredTimelineSubjectId((current) => (current === event.subjectId ? null : current));
                              }}
                              style={{
                                top: `${event.topPct}%`,
                                height: `${Math.max(event.heightPct, 4)}%`,
                                left: `calc(${overlapLeft}% + 2px)`,
                                width: `calc(${Math.max(overlapWidth, 2)}% - 4px)`,
                                right: "auto",
                                borderColor: event.isBlockSubject && compareEntities.length === 0 ? "#d9b5aa" : event.laneColor,
                                backgroundColor: eventBackgroundColor,
                                backgroundImage: weekStripeOverlay,
                              }}
                            >
                              {eventBody}
                            </article>

                            {isExpanded ? (
                              <article
                                key={`${event.key}_popout`}
                                className={`${eventClassName} weekly-event-popout`}
                                style={{
                                  top: `${event.topPct}%`,
                                  height: `${Math.max(event.heightPct, 4)}%`,
                                  left: "2px",
                                  width: "calc(100% - 4px)",
                                  right: "auto",
                                  borderColor: event.isBlockSubject && compareEntities.length === 0 ? "#d9b5aa" : event.laneColor,
                                  backgroundColor: eventBackgroundColor,
                                  backgroundImage: weekStripeOverlay,
                                }}
                              >
                                {eventBody}
                              </article>
                            ) : null}
                          </Fragment>
                        );
                      });
                    })()}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {schedule.length > 0 && (
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
              <h2 style={{ marginBottom: 0 }}>Teacher On-Site Time</h2>
              <button type="button" className="secondary" onClick={() => setTeacherOnSiteCollapsed((prev) => !prev)}>
                {teacherOnSiteCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
            {!teacherOnSiteCollapsed && (
              <>
                <p style={{ marginTop: "6px", marginBottom: "8px", fontSize: "0.88em" }}>
                  First start to last end per day, summed by week.
                </p>
                <input
                  type="text"
                  value={teacherOnSiteSearchQuery}
                  onChange={(e) => setTeacherOnSiteSearchQuery(e.target.value)}
                  placeholder="Search teacher"
                  style={{ marginBottom: "8px", fontSize: "0.85em" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "6px" }}>
                  <select
                    value={teacherOnSiteSortMode}
                    onChange={(e) => setTeacherOnSiteSortMode(e.target.value as "name" | "time")}
                    style={{ fontSize: "0.82em", width: "140px" }}
                    aria-label="Sort teacher on-site list"
                  >
                    <option value="name">Sort: Name</option>
                    <option value="time">Sort: Time</option>
                  </select>
                </div>
                <div className="list" style={{ maxHeight: "250px", fontSize: "0.84em" }}>
                  {sortedFilteredTeacherOnSiteSummaries.length === 0 ? (
                    <p style={{ color: "#999", margin: 0 }}>
                      No teacher matches "{teacherOnSiteSearchQuery}".
                    </p>
                  ) : (
                    sortedFilteredTeacherOnSiteSummaries.map(({ teacher, totals }) => (
                      <div
                        key={teacher.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: enableAlternatingWeeks ? "1.3fr 0.8fr 0.8fr 0.8fr" : "1.3fr 0.9fr",
                          gap: "6px",
                          alignItems: "center",
                          padding: "4px 0",
                          borderBottom: "1px solid #efefef",
                        }}
                      >
                        <strong style={{ fontSize: "0.95em" }}>{teacher.name}</strong>
                        <span>A: {totals.aText}</span>
                        {enableAlternatingWeeks && <span>B: {totals.bText}</span>}
                        {enableAlternatingWeeks && <span>Avg: {totals.averageText}</span>}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        )}

      </>
      )}
    </main>
  );
}
