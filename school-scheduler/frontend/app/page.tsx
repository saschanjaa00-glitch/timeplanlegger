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
  link_group_id?: string;
  // alternating_week_split is DISABLED - auto-balancing is used instead
  force_place?: boolean;
  force_timeslot_id?: string;
  allowed_timeslots?: string[];
  allowed_block_ids?: string[];
  preferred_room_ids?: string[];
  room_requirement_mode?: "always" | "once_per_week";
};

type Teacher = {
  id: string;
  name: string;
  avdeling?: string;
  preferred_avoid_timeslots: string[];
  unavailable_timeslots: string[];
  workload_percent: number;
  preferred_room_ids: string[];
  room_requirement_mode: "always" | "once_per_week";
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
  teacher_ids: string[];
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
  prioritize_for_preferred_subjects?: boolean;
};

type SportsHall = {
  id: string;
  name: string;
  allowed_subject_ids: string[];
};

type TabKey = "files" | "calendar" | "classes" | "subjects" | "faggrupper" | "blocks" | "meetings" | "rom" | "teachers" | "generate" | "overview";

type WeekView = "both" | "A" | "B";
type OverviewSubtab = "rooms" | "teachers" | "classes" | "constraints";

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

type PlacementWarningDetail = {
  subject_id: string;
  subject_name: string;
  week: "A" | "B";
  required_units: number;
  placed_units: number;
  missing_units: number;
};

type UnplacedStatusDetail = {
  subject_id: string;
  subject_name: string;
  teacher_label: string;
  required_units: number;
  placed_units: number;
  missing_units: number;
  reason: string;
};

type SavedJsonExport = {
  id: string;
  name: string;
  created_at: string;
  payload: string;
};

type SubjectTabEntry = {
  subject: Subject;
  derivedClassIds: string[];
};

type BlokkfagGroup = {
  key: string;
  title: string;
  entries: SubjectTabEntry[];
  blockNames?: string[];
};

type PersistedState = {
  subjects: Subject[];
  teachers: Teacher[];
  meetings: Meeting[];
  rooms: Room[];
  sports_halls?: SportsHall[];
  classes: SchoolClass[];
  timeslots: Timeslot[];
  weekCalendarSetups: WeekCalendarSetup[];
  blocks: Block[];
  schedule: ScheduledItem[];
  activeCalendarDay: string;
  activeTab: TabKey;
  activeWeekSetupId: string | null;
  weekView: WeekView;
  savedJsonExports?: SavedJsonExport[];
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
    const hasWeekSpecific = bucket.a.length > 0 || bucket.b.length > 0;
    // If explicit week-specific rows exist for this exact signature,
    // prefer those and avoid also rendering legacy shared rows.
    if (bucket.shared.length > 0 && !hasWeekSpecific) {
      merged.push(...bucket.shared);
    }

    const bUsed = new Array(bucket.b.length).fill(false);

    for (const aItem of bucket.a) {
      // Only collapse A+B into a shared entry when room assignment matches.
      // If rooms differ by week, keep them separate so the timeline shows that.
      const matchIdx = bucket.b.findIndex((bItem, idx) => !bUsed[idx] && (bItem.room_id ?? "") === (aItem.room_id ?? ""));
      if (matchIdx >= 0) {
        bUsed[matchIdx] = true;
        merged.push({ ...aItem, week_type: undefined });
      } else {
        merged.push(aItem);
      }
    }

    bucket.b.forEach((bItem, idx) => {
      if (!bUsed[idx]) {
        merged.push(bItem);
      }
    });
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

function getFailedWeeksFromMetadata(metadata?: Record<string, number>): Array<"A" | "B"> {
  const failedWeeks: Array<"A" | "B"> = [];
  if ((metadata?.failed_week_a ?? 0) > 0) {
    failedWeeks.push("A");
  }
  if ((metadata?.failed_week_b ?? 0) > 0) {
    failedWeeks.push("B");
  }
  return failedWeeks;
}

function scheduledItemUnits(item: ScheduledItem, timeslotById: Record<string, Timeslot>): number {
  const itemStart = toMinutes(item.start_time);
  const itemEnd = toMinutes(item.end_time);
  if (itemStart !== Number.MAX_SAFE_INTEGER && itemEnd !== Number.MAX_SAFE_INTEGER && itemEnd > itemStart) {
    return Math.max(1, Math.round((itemEnd - itemStart) / 45));
  }

  const slot = timeslotById[item.timeslot_id];
  if (!slot) {
    return 1;
  }
  const slotStart = toMinutes(slot.start_time);
  const slotEnd = toMinutes(slot.end_time);
  if (slotStart !== Number.MAX_SAFE_INTEGER && slotEnd !== Number.MAX_SAFE_INTEGER && slotEnd > slotStart) {
    return Math.max(1, Math.round((slotEnd - slotStart) / 45));
  }
  return 1;
}

function collectPlacementWarningDetails(
  response: GenerateResponse,
  plannedSubjects: Subject[],
  timeslots: Timeslot[],
  blockLinkedSubjectIds: Set<string>,
  alternatingWeeksEnabled: boolean,
): PlacementWarningDetail[] {
  const failedWeeks = getFailedWeeksFromMetadata(response.metadata);
  if (failedWeeks.length === 0) {
    return [];
  }

  const timeslotById: Record<string, Timeslot> = Object.fromEntries(timeslots.map((slot) => [slot.id, slot]));
  const placedUnitsBySubjectWeek: Record<string, { A: number; B: number }> = {};

  for (const subject of plannedSubjects) {
    placedUnitsBySubjectWeek[subject.id] = { A: 0, B: 0 };
  }

  for (const item of response.schedule || []) {
    const tracker = placedUnitsBySubjectWeek[item.subject_id];
    if (!tracker) {
      continue;
    }

    const units = scheduledItemUnits(item, timeslotById);
    if (item.week_type === "A") {
      tracker.A += units;
      continue;
    }
    if (item.week_type === "B") {
      tracker.B += units;
      continue;
    }

    if (failedWeeks.includes("A")) {
      tracker.A += units;
    }
    if (failedWeeks.includes("B")) {
      tracker.B += units;
    }
  }

  const details: PlacementWarningDetail[] = [];
  for (const subject of plannedSubjects) {
    const isBlockLinked = blockLinkedSubjectIds.has(subject.id) || Boolean(subject.allowed_block_ids?.length);
    if (isBlockLinked) {
      continue;
    }

    const requiredUnits = Math.max(1, Number(subject.sessions_per_week || 1));
    // In alternating-week mode, subject.sessions_per_week is a two-week total.
    // Compare each week against a per-week baseline (floor split), otherwise
    // warnings will incorrectly claim "no space" for valid 2/3 or 3/4 splits.
    const minimumExpectedUnits = alternatingWeeksEnabled
      ? Math.floor(requiredUnits / 2)
      : (requiredUnits % 2 === 1
        ? Math.max(0, requiredUnits - 1)
        : requiredUnits);
    const warningRequiredUnits = alternatingWeeksEnabled
      ? Math.max(1, Math.ceil(requiredUnits / 2))
      : requiredUnits;
    const placed = placedUnitsBySubjectWeek[subject.id] ?? { A: 0, B: 0 };

    for (const week of failedWeeks) {
      const placedUnits = week === "A" ? placed.A : placed.B;
      if (placedUnits >= minimumExpectedUnits) {
        continue;
      }

      details.push({
        subject_id: subject.id,
        subject_name: subject.name,
        week,
        required_units: warningRequiredUnits,
        placed_units: placedUnits,
        missing_units: minimumExpectedUnits - placedUnits,
      });
    }
  }

  details.sort((a, b) => {
    if (b.missing_units !== a.missing_units) {
      return b.missing_units - a.missing_units;
    }
    const weekCmp = a.week.localeCompare(b.week);
    if (weekCmp !== 0) {
      return weekCmp;
    }
    return a.subject_name.localeCompare(b.subject_name);
  });

  return details;
}

function collectUnplacedStatusDetails(
  response: GenerateResponse,
  plannedSubjects: Subject[],
  timeslots: Timeslot[],
  blockLinkedSubjectIds: Set<string>,
  alternatingWeeksEnabled: boolean,
  teacherNameById: Record<string, string>,
): UnplacedStatusDetail[] {
  const timeslotById: Record<string, Timeslot> = Object.fromEntries(timeslots.map((slot) => [slot.id, slot]));
  const placedUnitsBySubject: Record<string, number> = {};
  const placedUnitsBySubjectWeek: Record<string, { A: number; B: number }> = {};
  const failedWeeks = getFailedWeeksFromMetadata(response.metadata);

  for (const subject of plannedSubjects) {
    placedUnitsBySubject[subject.id] = 0;
    placedUnitsBySubjectWeek[subject.id] = { A: 0, B: 0 };
  }

  for (const item of response.schedule || []) {
    if (!(item.subject_id in placedUnitsBySubject)) {
      continue;
    }
    const units = scheduledItemUnits(item, timeslotById);
    placedUnitsBySubject[item.subject_id] += units;

    if (item.week_type === "A") {
      placedUnitsBySubjectWeek[item.subject_id].A += units;
    } else if (item.week_type === "B") {
      placedUnitsBySubjectWeek[item.subject_id].B += units;
    } else if (alternatingWeeksEnabled) {
      // Shared item counts toward both weeks in alternating mode.
      placedUnitsBySubjectWeek[item.subject_id].A += units;
      placedUnitsBySubjectWeek[item.subject_id].B += units;
    }
  }

  const details: UnplacedStatusDetail[] = [];
  for (const subject of plannedSubjects) {
    const perWeekUnits = Math.max(1, Number(subject.sessions_per_week || 1));
    const requiredTotalUnits = alternatingWeeksEnabled ? perWeekUnits * 2 : perWeekUnits;
    const placedTotalUnits = placedUnitsBySubject[subject.id] ?? 0;
    if (placedTotalUnits >= requiredTotalUnits) {
      continue;
    }

    const teacherIds = Array.from(new Set([
      ...(subject.teacher_id ? [subject.teacher_id] : []),
      ...(subject.teacher_ids ?? []),
    ].filter(Boolean)));
    const teacherLabel = teacherIds.length > 0
      ? teacherIds.map((teacherId) => teacherNameById[teacherId] ?? teacherId).join(", ")
      : "Unassigned";

    const isBlockLinked = blockLinkedSubjectIds.has(subject.id);
    const reasonParts: string[] = [];
    if (isBlockLinked) {
      if (placedTotalUnits === 0) {
        reasonParts.push("No feasible placement was found inside the configured block windows/weeks for this run.");
      } else {
        reasonParts.push("Subject is partially placed in configured block windows/weeks; remaining units did not fit.");
      }
      if (response.status !== "success") {
        reasonParts.push("Overall schedule run is infeasible under current hard constraints.");
      }
    } else if (response.status !== "success") {
      reasonParts.push(response.message || "Solver reported infeasible schedule.");
    } else {
      reasonParts.push("Could not place all required units with current constraints.");
    }

    if (alternatingWeeksEnabled && failedWeeks.length > 0) {
      const weekShortfalls = failedWeeks.filter((week) => {
        const placedWeekUnits = week === "A"
          ? (placedUnitsBySubjectWeek[subject.id]?.A ?? 0)
          : (placedUnitsBySubjectWeek[subject.id]?.B ?? 0);
        return placedWeekUnits < Math.floor(perWeekUnits / 2);
      });
      if (weekShortfalls.length > 0) {
        reasonParts.push(`Shortfall detected in week ${weekShortfalls.join("+")}.`);
      }
    }

    details.push({
      subject_id: subject.id,
      subject_name: subject.name,
      teacher_label: teacherLabel,
      required_units: requiredTotalUnits,
      placed_units: placedTotalUnits,
      missing_units: requiredTotalUnits - placedTotalUnits,
      reason: reasonParts.join(" "),
    });
  }

  details.sort((a, b) => {
    if (b.missing_units !== a.missing_units) {
      return b.missing_units - a.missing_units;
    }
    return a.subject_name.localeCompare(b.subject_name);
  });

  return details;
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
  { id: "files", label: "Files" },
  { id: "calendar", label: "Week Calendar" },
  { id: "classes", label: "Classes" },
  { id: "subjects", label: "Subjects" },
  { id: "faggrupper", label: "Fellesfag" },
  { id: "blocks", label: "Blocks" },
  { id: "meetings", label: "Møter" },
  { id: "rom", label: "Rom" },
  { id: "teachers", label: "Teachers" },
  { id: "generate", label: "Generate" },
  { id: "overview", label: "Oversikt" },
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
      ? block.subject_entries.map((se) => {
          const normalizedTeacherIds = Array.isArray(se.teacher_ids)
            ? se.teacher_ids.map((id) => String(id).trim()).filter(Boolean)
            : [];
          const fallbackTeacherId = typeof se.teacher_id === "string" ? se.teacher_id.trim() : "";
          const teacherIds = Array.from(new Set([
            ...(fallbackTeacherId ? [fallbackTeacherId] : []),
            ...normalizedTeacherIds,
          ]));
          return {
            subject_id: se.subject_id ?? "",
            teacher_id: teacherIds[0] ?? "",
            teacher_ids: teacherIds,
            preferred_room_id: se.preferred_room_id ?? "",
          };
        })
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
    link_group_id:
      typeof subject.link_group_id === "string" && subject.link_group_id.trim()
        ? subject.link_group_id.trim()
        : undefined,
    force_place: Boolean(subject.force_place),
    force_timeslot_id:
      typeof subject.force_timeslot_id === "string" && subject.force_timeslot_id.trim()
        ? subject.force_timeslot_id.trim()
        : undefined,
    // alternating_week_split is DISABLED
    allowed_timeslots: Array.isArray(subject.allowed_timeslots) ? subject.allowed_timeslots : undefined,
    allowed_block_ids: Array.isArray(subject.allowed_block_ids) ? subject.allowed_block_ids : undefined,
    preferred_room_ids: Array.isArray(subject.preferred_room_ids) ? subject.preferred_room_ids.filter(Boolean) : [],
    room_requirement_mode: subject.room_requirement_mode === "once_per_week" ? "once_per_week" : "always",
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
    preferred_room_ids: Array.isArray(teacher.preferred_room_ids) ? teacher.preferred_room_ids.filter(Boolean) : [],
    room_requirement_mode: teacher.room_requirement_mode === "once_per_week" ? "once_per_week" : "always",
  };
}

function normalizeRoom(room: Partial<Room>): Room {
  return {
    id: room.id ?? "",
    name: room.name ?? "",
    prioritize_for_preferred_subjects: Boolean(room.prioritize_for_preferred_subjects),
  };
}

function normalizeSportsHall(sh: Partial<SportsHall>): SportsHall {
  return {
    id: sh.id ?? "",
    name: sh.name ?? "",
    allowed_subject_ids: Array.isArray(sh.allowed_subject_ids) ? sh.allowed_subject_ids.filter(Boolean) : [],
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
    .replace(/[æå]/g, "ae")
    .replace(/[øœ]/g, "o")
    .replace(/[áà]/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCommaSeparatedFilterValues(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeSearchText(part))
    .filter(Boolean);
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

const SPORTS_SUBJECT_KEYWORDS = ["kroppsøving", "aktivitetslære", "treningsledelse", "breddeidrett", "idrett", "toppidrett"];

export default function Home() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [sportsHalls, setSportsHalls] = useState<SportsHall[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [timeslots, setTimeslots] = useState<Timeslot[]>([]);
  const [weekCalendarSetups, setWeekCalendarSetups] = useState<WeekCalendarSetup[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [schedule, setSchedule] = useState<ScheduledItem[]>([]);
  const [statusText, setStatusText] = useState("Ready");
  const [placementWarningDetails, setPlacementWarningDetails] = useState<PlacementWarningDetail[]>([]);
  const [placementWarningSummary, setPlacementWarningSummary] = useState("");
  const [unplacedStatusDetails, setUnplacedStatusDetails] = useState<UnplacedStatusDetail[]>([]);
  const [unplacedStatusSummary, setUnplacedStatusSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("files");
  const [activeOverviewSubtab, setActiveOverviewSubtab] = useState<OverviewSubtab>("rooms");
  const enableAlternatingWeeks = true;
  const [weekView, setWeekView] = useState<WeekView>("both");
  const alternateNonBlockSubjects = true;

  const [subjectForm, setSubjectForm] = useState({
    name: "",
    subject_type: "fellesfag" as "fellesfag" | "programfag",
    block_id: "",
    class_ids: [] as string[],
  });
  const [teacherForm, setTeacherForm] = useState({
    name: "",
    unavailable_timeslots: "",
    workload_percent: "100",
    room_requirement_mode: "always" as "always" | "once_per_week",
  });
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
  const [preferencesRoomId, setPreferencesRoomId] = useState<string | null>(null);
  const [preferencesRoomPriorityOnly, setPreferencesRoomPriorityOnly] = useState(false);
  const [sportsHallForm, setSportsHallForm] = useState({ name: "" });
  const [editingSportsHallId, setEditingSportsHallId] = useState<string | null>(null);
  const [sportsHallPreferencesId, setSportsHallPreferencesId] = useState<string | null>(null);
  const [sportsHallSubjectSearch, setSportsHallSubjectSearch] = useState("");
  const [teacherSearchQuery, setTeacherSearchQuery] = useState("");
  const [teacherRoomSearchByTeacherId, setTeacherRoomSearchByTeacherId] = useState<Record<string, string>>({});
  const [teacherSearchBySubjectEntity, setTeacherSearchBySubjectEntity] = useState<Record<string, string>>({});
  const [selectedClassCompareIds, setSelectedClassCompareIds] = useState<string[]>([]);
  const [selectedTeacherCompareIds, setSelectedTeacherCompareIds] = useState<string[]>([]);
  const [selectedRoomCompareIds, setSelectedRoomCompareIds] = useState<string[]>([]);
  const [compareClassSearchQuery, setCompareClassSearchQuery] = useState("");
  const [compareTeacherSearchQuery, setCompareTeacherSearchQuery] = useState("");
  const [compareRoomSearchQuery, setCompareRoomSearchQuery] = useState("");
  const [teacherOnSiteSearchQuery, setTeacherOnSiteSearchQuery] = useState("");
  const [teacherOnSiteCollapsed, setTeacherOnSiteCollapsed] = useState(false);
  const [teacherOnSiteSortMode, setTeacherOnSiteSortMode] = useState<"name" | "time">("name");
  const [savedJsonExports, setSavedJsonExports] = useState<SavedJsonExport[]>([]);
  const [showUltrawideTimeline, setShowUltrawideTimeline] = useState(true);
  const [hoveredTimelineEventKey, setHoveredTimelineEventKey] = useState<string | null>(null);
  const [hoveredTimelineSubjectId, setHoveredTimelineSubjectId] = useState<string | null>(null);
  const [expandedTimelineEventKey, setExpandedTimelineEventKey] = useState<string | null>(null);
  const [overviewHoverCard, setOverviewHoverCard] = useState<{
    x: number;
    y: number;
    title: string;
    lines: string[];
  } | null>(null);
  const [overviewHoverSubjectKey, setOverviewHoverSubjectKey] = useState<string | null>(null);
  const [overviewClassFilterQuery, setOverviewClassFilterQuery] = useState("");
  const [overviewTeacherFilterQuery, setOverviewTeacherFilterQuery] = useState("");
  const [overviewRoomFilterQuery, setOverviewRoomFilterQuery] = useState("");
  const [overviewSelectedRowIds, setOverviewSelectedRowIds] = useState<string[]>([]);
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
  const [blokkfagSortMode, setBlokkfagSortMode] = useState<"block" | "subject">("block");
  const [expandedBlokkfagSubjectGroups, setExpandedBlokkfagSubjectGroups] = useState<Set<string>>(new Set());
  const [blockAddSubjectPopupBlockId, setBlockAddSubjectPopupBlockId] = useState<string | null>(null);
  const [blockAddSubjectName, setBlockAddSubjectName] = useState("");
  const [excludedSessionSearchBySubjectEntity, setExcludedSessionSearchBySubjectEntity] = useState<Record<string, string>>({});
  const [roomSearchBySubjectEntity, setRoomSearchBySubjectEntity] = useState<Record<string, string>>({});
  const [overviewTeacherUnavailableDraftById, setOverviewTeacherUnavailableDraftById] = useState<Record<string, string>>({});
  const [fellesfagSelectionByClass, setFellesfagSelectionByClass] = useState<Record<string, string>>({});
  const [newFellesfagNameByClass, setNewFellesfagNameByClass] = useState<Record<string, string>>({});
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
  const [isStorageHydrated, setIsStorageHydrated] = useState(false);
  const [expandedTeacherId, setExpandedTeacherId] = useState<string | null>(null);
  const [expandedBlockId, setExpandedBlockId] = useState<string | null>(null);
  const [blockInlineSubjNames, setBlockInlineSubjNames] = useState<Record<string, string>>({});
  const excelFileRef = useRef<HTMLInputElement>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  const generationRunRef = useRef(0);

  function buildPersistedState(): PersistedState {
    return {
      subjects,
      teachers,
      meetings,
      rooms,
      sports_halls: sportsHalls,
      classes,
      timeslots,
      weekCalendarSetups,
      blocks,
      schedule,
      activeCalendarDay,
      activeTab,
      activeWeekSetupId,
      weekView,
      savedJsonExports,
    };
  }

  function applyPersistedState(parsed: Partial<PersistedState>) {
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
      setRooms(parsed.rooms.map((room) => normalizeRoom(room)));
    }
    if (Array.isArray(parsed.sports_halls)) {
      setSportsHalls(parsed.sports_halls.map((sh) => normalizeSportsHall(sh)));
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

    if (Array.isArray(parsed.savedJsonExports)) {
      const normalized = parsed.savedJsonExports
        .filter((entry): entry is SavedJsonExport => Boolean(entry?.id && entry?.name && entry?.created_at && entry?.payload))
        .slice(0, 30);
      setSavedJsonExports(normalized);
    }
  }

  function formatExportTimestamp(date = new Date()): string {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  function downloadJsonFile(fileName: string, content: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);
  }

  function exportCurrentState(customName?: string) {
    const now = new Date();
    const stamp = formatExportTimestamp(now);
    const baseName = (customName && customName.trim()) ? customName.trim() : `scheduler-export-${stamp}`;
    const fileName = baseName.endsWith(".json") ? baseName : `${baseName}.json`;
    const payloadText = JSON.stringify(buildPersistedState(), null, 2);

    downloadJsonFile(fileName, payloadText);

    const saved: SavedJsonExport = {
      id: `${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
      name: fileName,
      created_at: now.toISOString(),
      payload: payloadText,
    };
    setSavedJsonExports((prev) => [saved, ...prev].slice(0, 30));
    setStatusText(`Exported ${fileName}`);
  }

  async function importStateFromFile(file: File) {
    const text = await file.text();
    const parsed = JSON.parse(text) as Partial<PersistedState>;
    applyPersistedState(parsed);
    setStatusText(`Imported ${file.name}`);
    setActiveTab("files");
  }

  async function handleImportJsonChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      await importStateFromFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not import file.";
      setStatusText(`Import failed: ${message}`);
    } finally {
      event.target.value = "";
    }
  }

  function restoreSavedExport(item: SavedJsonExport) {
    const proceed = window.confirm(`Load ${item.name}? This will replace current in-app data.`);
    if (!proceed) {
      return;
    }

    const saveBefore = window.confirm("Do you want to export your current data to a new JSON before loading this file?");
    if (saveBefore) {
      exportCurrentState(`before-restore-${formatExportTimestamp()}`);
    }

    try {
      const parsed = JSON.parse(item.payload) as Partial<PersistedState>;
      applyPersistedState(parsed);
      setStatusText(`Loaded ${item.name}`);
      setActiveTab("files");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load saved export.";
      setStatusText(`Load failed: ${message}`);
    }
  }

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
        sports_halls: SportsHall[];
        classes: SchoolClass[];
        timeslots: Timeslot[];
        weekCalendarSetups: WeekCalendarSetup[];
        blocks: Block[];
        schedule: ScheduledItem[];
        activeCalendarDay: string;
        activeTab: TabKey;
        activeWeekSetupId: string | null;
        weekView: WeekView;
        savedJsonExports: SavedJsonExport[];
      }>;

      applyPersistedState(parsed);
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

    const persisted: PersistedState = {
      subjects,
      teachers,
      meetings,
      rooms,
      sports_halls: sportsHalls,
      classes,
      timeslots,
      weekCalendarSetups,
      blocks,
      schedule,
      activeCalendarDay,
      activeTab,
      activeWeekSetupId,
      weekView,
      savedJsonExports,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  }, [
    isStorageHydrated,
    subjects,
    teachers,
    meetings,
    rooms,
    sportsHalls,
    classes,
    timeslots,
    weekCalendarSetups,
    blocks,
    schedule,
    activeCalendarDay,
    activeTab,
    activeWeekSetupId,
    weekView,
    savedJsonExports,
  ]);

  useEffect(() => {
    if (!isStorageHydrated) {
      return;
    }
    setBlocks((prev) => prev.map((block) => normalizeBlock(block)));
  }, [isStorageHydrated]);

  useEffect(() => {
    if (!weekCalendarSetups.length || !classes.length) {
      return;
    }

    const assignedClassIds = new Set(weekCalendarSetups.flatMap((setup) => setup.class_ids));
    const unassignedClassIds = classes
      .map((schoolClass) => schoolClass.id)
      .filter((classId) => !assignedClassIds.has(classId));

    if (!unassignedClassIds.length) {
      return;
    }

    const fallbackSetupId =
      (activeWeekSetupId && weekCalendarSetups.some((setup) => setup.id === activeWeekSetupId)
        ? activeWeekSetupId
        : weekCalendarSetups[0]?.id) ?? "";

    if (!fallbackSetupId) {
      return;
    }

    setWeekCalendarSetups((prev) => prev.map((setup) => (
      setup.id === fallbackSetupId
        ? { ...setup, class_ids: Array.from(new Set([...setup.class_ids, ...unassignedClassIds])) }
        : setup
    )));
  }, [classes, weekCalendarSetups, activeWeekSetupId]);

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

  const classRowsByYear = useMemo(() => {
    return (["1", "2", "3"] as const).map((yearPrefix) => ({
      yearPrefix,
      classes: sortedClasses.filter((schoolClass) => schoolClass.name.trim().startsWith(yearPrefix)),
    }));
  }, [sortedClasses]);

  const sortedRooms = useMemo(() => {
    return [...rooms].sort((a, b) => a.name.localeCompare(b.name));
  }, [rooms]);

  const displayRoomOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const room of rooms) {
      byId.set(room.id, room.name || room.id);
    }
    for (const hall of sportsHalls) {
      if (!byId.has(hall.id)) {
        byId.set(hall.id, hall.name || hall.id);
      }
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rooms, sportsHalls]);

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
      return displayRoomOptions;
    }
    return displayRoomOptions.filter((room) =>
      room.name.toLowerCase().includes(q) || room.id.toLowerCase().includes(q)
    );
  }, [displayRoomOptions, compareRoomSearchQuery]);

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

    // Count all meeting assignments as fixed teacher presence.
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
        if (assignment.mode !== "preferred" && assignment.mode !== "unavailable") {
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

  function filterRoomsForQuery(query: string): Room[] {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return sortedRooms;
    }
    return sortedRooms.filter((room) => (
      normalizeSearchText(room.name).includes(normalizedQuery)
      || normalizeSearchText(room.id).includes(normalizedQuery)
    ));
  }

  function resolveRoomIdFromInput(inputValue: string): string | null {
    const normalizedInput = normalizeSearchText(inputValue);
    if (!normalizedInput) {
      return "";
    }
    const exactMatch = rooms.find((room) => (
      normalizeSearchText(room.name) === normalizedInput
      || normalizeSearchText(room.id) === normalizedInput
    ));
    return exactMatch ? exactMatch.id : null;
  }

  function resolveRoomIdsFromInput(inputValue: string): string[] | null {
    const tokens = inputValue
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return [];
    }

    const resolved: string[] = [];
    for (const token of tokens) {
      const resolvedId = resolveRoomIdFromInput(token);
      if (resolvedId === null) {
        return null;
      }
      if (resolvedId) {
        resolved.push(resolvedId);
      }
    }

    return Array.from(new Set(resolved));
  }

  function formatTimeslotLabel(slot: Timeslot): string {
    return `${slot.day} P${slot.period}${slot.start_time && slot.end_time ? ` (${slot.start_time}-${slot.end_time})` : ""}`;
  }

  function filterTimeslotsForQuery(query: string): Timeslot[] {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return sortedTimeslots;
    }
    return sortedTimeslots.filter((slot) => {
      const label = formatTimeslotLabel(slot);
      return normalizeSearchText(label).includes(normalizedQuery) || normalizeSearchText(slot.id).includes(normalizedQuery);
    });
  }

  function resolveTimeslotIdFromInput(inputValue: string): string | null {
    const normalizedInput = normalizeSearchText(inputValue);
    if (!normalizedInput) {
      return "";
    }
    const exactMatch = sortedTimeslots.find((slot) => {
      const label = formatTimeslotLabel(slot);
      return normalizeSearchText(label) === normalizedInput || normalizeSearchText(slot.id) === normalizedInput;
    });
    return exactMatch ? exactMatch.id : null;
  }

  function resolveTimeslotIdsFromInput(inputValue: string): string[] | null {
    const tokens = inputValue
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return [];
    }

    const resolved: string[] = [];
    for (const token of tokens) {
      const resolvedId = resolveTimeslotIdFromInput(token);
      if (resolvedId === null) {
        return null;
      }
      if (resolvedId) {
        resolved.push(resolvedId);
      }
    }

    return Array.from(new Set(resolved));
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
          ? { ...room, name: input, prioritize_for_preferred_subjects: Boolean(room.prioritize_for_preferred_subjects) }
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
      newRooms.push({ id, name, prioritize_for_preferred_subjects: false });
    }

    setRooms((prev) => [...prev, ...newRooms]);
    const message = roomNames.length === 1 ? `Added room ${roomNames[0]}.` : `Added ${roomNames.length} rooms.`;
    setStatusText(message);
    setRoomForm({ name: "" });
  }

  function deleteRoom(roomId: string) {
    const roomName = rooms.find((room) => room.id === roomId)?.name ?? roomId;
    setRooms((prev) => prev.filter((room) => room.id !== roomId));
    setSubjects((prev) => prev.map((subject) => ({
      ...subject,
      preferred_room_ids: (subject.preferred_room_ids ?? []).filter((id) => id !== roomId),
    })));
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

  function openRoomPreferences(room: Room) {
    setPreferencesRoomId(room.id);
    setPreferencesRoomPriorityOnly(Boolean(room.prioritize_for_preferred_subjects));
  }

  function saveRoomPreferences() {
    if (!preferencesRoomId) {
      return;
    }
    setRooms((prev) => prev.map((room) => (
      room.id === preferencesRoomId
        ? { ...room, prioritize_for_preferred_subjects: preferencesRoomPriorityOnly }
        : room
    )));
    const roomName = rooms.find((room) => room.id === preferencesRoomId)?.name ?? preferencesRoomId;
    setStatusText(
      preferencesRoomPriorityOnly
        ? `Saved preferences for ${roomName}: prioritize for preferred subjects.`
        : `Saved preferences for ${roomName}: available for all subjects.`
    );
    setPreferencesRoomId(null);
  }

  function upsertSportsHall() {
    const input = sportsHallForm.name.trim();
    if (!input) {
      setStatusText("Sports hall name is required.");
      return;
    }
    if (editingSportsHallId) {
      setSportsHalls((prev) => prev.map((sh) => (
        sh.id === editingSportsHallId ? { ...sh, name: input } : sh
      )));
      setStatusText(`Updated sports hall ${input}.`);
      setSportsHallForm({ name: "" });
      setEditingSportsHallId(null);
      return;
    }
    const names = input.split(",").map((n) => n.trim()).filter((n) => n.length > 0);
    const existingIds = sportsHalls.map((sh) => sh.id);
    const autoAllowedSubjectIds = Array.from(new Set(
      subjects
        .filter((s) => SPORTS_SUBJECT_KEYWORDS.some((kw) => normalizeSearchText(s.name).includes(normalizeSearchText(kw))))
        .map((s) => s.id)
    ));
    const newHalls: SportsHall[] = [];
    for (const name of names) {
      const id = makeUniqueId(`sh_${toSlug(name) || "item"}`, [...existingIds, ...newHalls.map((h) => h.id)]);
      newHalls.push({ id, name, allowed_subject_ids: autoAllowedSubjectIds });
    }
    setSportsHalls((prev) => [...prev, ...newHalls]);
    const autoInfo = autoAllowedSubjectIds.length > 0
      ? ` Auto-enabled preferences for ${autoAllowedSubjectIds.length} sports subject(s).`
      : "";
    setStatusText((names.length === 1 ? `Added sports hall ${names[0]}.` : `Added ${names.length} sports halls.`) + autoInfo);
    setSportsHallForm({ name: "" });
  }

  function deleteSportsHall(hallId: string) {
    const hallName = sportsHalls.find((sh) => sh.id === hallId)?.name ?? hallId;
    setSportsHalls((prev) => prev.filter((sh) => sh.id !== hallId));
    if (editingSportsHallId === hallId) {
      setSportsHallForm({ name: "" });
      setEditingSportsHallId(null);
    }
    setStatusText(`Deleted sports hall ${hallName}.`);
  }

  function loadSportsHallIntoForm(hall: SportsHall) {
    setSportsHallForm({ name: hall.name });
    setEditingSportsHallId(hall.id);
  }

  function toggleSportsHallSubjectGroup(hallId: string, groupIds: string[], allChecked: boolean) {
    setSportsHalls((prev) => prev.map((sh) => {
      if (sh.id !== hallId) return sh;
      if (allChecked) {
        return { ...sh, allowed_subject_ids: sh.allowed_subject_ids.filter((id) => !groupIds.includes(id)) };
      }
      const current = new Set(sh.allowed_subject_ids);
      groupIds.forEach((id) => current.add(id));
      return { ...sh, allowed_subject_ids: Array.from(current) };
    }));
  }

  function openSportsHallPreferences(hallId: string) {
    const hall = sportsHalls.find((sh) => sh.id === hallId);
    if (!hall) return;
    if (hall.allowed_subject_ids.length === 0) {
      const autoIds = subjects
        .filter((s) => SPORTS_SUBJECT_KEYWORDS.some((kw) => s.name.toLowerCase().includes(kw)))
        .map((s) => s.id);
      if (autoIds.length > 0) {
        setSportsHalls((prev) => prev.map((sh) =>
          sh.id === hallId ? { ...sh, allowed_subject_ids: autoIds } : sh
        ));
      }
    }
    setSportsHallPreferencesId(hallId);
    setSportsHallSubjectSearch("");
  }

  function autoAssignSubjectIdsToSportsHalls(subjectIds: string[], subjectName: string) {
    const normalizedName = normalizeSearchText(subjectName);
    const shouldAutoAssign = SPORTS_SUBJECT_KEYWORDS.some((kw) => normalizedName.includes(normalizeSearchText(kw)));
    if (!shouldAutoAssign || subjectIds.length === 0) {
      return;
    }

    const uniqueSubjectIds = Array.from(new Set(subjectIds.filter(Boolean)));
    if (uniqueSubjectIds.length === 0) {
      return;
    }

    setSportsHalls((prev) => prev.map((hall) => {
      const current = new Set(hall.allowed_subject_ids);
      let changed = false;
      for (const subjectId of uniqueSubjectIds) {
        if (!current.has(subjectId)) {
          current.add(subjectId);
          changed = true;
        }
      }
      return changed
        ? { ...hall, allowed_subject_ids: Array.from(current) }
        : hall;
    }));
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

  function getProgramfagTeacherIdsFromBlocks(subjectId: string): string[] {
    return Array.from(
      new Set(
        blocks
          .flatMap((block) => block.subject_entries ?? [])
          .filter((entry) => entry.subject_id === subjectId)
          .flatMap((entry) => [
            ...(entry.teacher_id ? [entry.teacher_id] : []),
            ...(entry.teacher_ids ?? []),
          ])
          .filter(Boolean)
      )
    );
  }

  function getProgramfagBlockId(subjectId: string): string {
    for (const block of blocks) {
      if ((block.subject_entries ?? []).some((entry) => entry.subject_id === subjectId)) {
        return block.id;
      }
      if ((block.subject_ids ?? []).includes(subjectId)) {
        return block.id;
      }
    }
    return "";
  }

  function assignProgramfagToBlock(subjectId: string, blockId: string) {
    const subject = subjects.find((s) => s.id === subjectId);
    if (!subject || subject.subject_type !== "programfag") {
      return;
    }

    const targetBlock = blocks.find((b) => b.id === blockId);
    const nextBlockId = targetBlock ? targetBlock.id : "";

    let carriedEntry: BlockSubjectEntry | null = null;
    for (const block of blocks) {
      const found = (block.subject_entries ?? []).find((entry) => entry.subject_id === subjectId);
      if (found) {
        carriedEntry = found;
        break;
      }
    }

    const fallbackTeacherIds = getSubjectTeacherIds(subject);
    const nextEntry: BlockSubjectEntry = carriedEntry
      ? {
          ...carriedEntry,
          subject_id: subjectId,
          teacher_id: carriedEntry.teacher_id || (carriedEntry.teacher_ids?.[0] ?? ""),
          teacher_ids: Array.from(new Set([
            ...(carriedEntry.teacher_id ? [carriedEntry.teacher_id] : []),
            ...(carriedEntry.teacher_ids ?? []),
          ].filter(Boolean))),
        }
      : {
          subject_id: subjectId,
          teacher_id: fallbackTeacherIds[0] ?? "",
          teacher_ids: fallbackTeacherIds,
          preferred_room_id: "",
        };

    setBlocks((prev) => prev.map((block) => {
      const cleanedEntries = (block.subject_entries ?? []).filter((entry) => entry.subject_id !== subjectId);
      const cleanedSubjectIds = (block.subject_ids ?? []).filter((id) => id !== subjectId);

      if (!nextBlockId || block.id !== nextBlockId) {
        return {
          ...block,
          subject_entries: cleanedEntries,
          subject_ids: cleanedSubjectIds,
        };
      }

      const hasEntry = cleanedEntries.some((entry) => entry.subject_id === subjectId);
      return {
        ...block,
        subject_entries: hasEntry ? cleanedEntries : [...cleanedEntries, nextEntry],
        subject_ids: cleanedSubjectIds,
      };
    }));

    updateSubjectCard(subjectId, {
      allowed_block_ids: nextBlockId ? [nextBlockId] : undefined,
    });

    if (!nextBlockId) {
      setStatusText(`Unassigned ${subject.name} from all blocks.`);
      return;
    }
    setStatusText(`Assigned ${subject.name} to block ${targetBlock?.name ?? nextBlockId}.`);
  }

  function addSubjectToBlockFromPopup(blockId: string) {
    const name = blockAddSubjectName.trim();
    if (!name) {
      setStatusText("Enter a subject name before adding it to the block.");
      return;
    }

    const targetBlock = blocks.find((block) => block.id === blockId);
    if (!targetBlock) {
      setStatusText("Could not find selected block.");
      return;
    }

    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((subject) => subject.id));
    const createdSubject: Subject = {
      id,
      name,
      teacher_id: "",
      teacher_ids: [],
      class_ids: [],
      subject_type: "programfag",
      sessions_per_week: 1,
      force_place: false,
      allowed_block_ids: [blockId],
      preferred_room_ids: [],
      room_requirement_mode: "always",
    };

    setSubjects((prev) => [...prev, createdSubject]);
    autoAssignSubjectIdsToSportsHalls([id], name);
    setBlocks((prev) => prev.map((block) => {
      if (block.id !== blockId) {
        return block;
      }
      return {
        ...block,
        subject_entries: [
          ...(block.subject_entries ?? []),
          { subject_id: id, teacher_id: "", teacher_ids: [], preferred_room_id: "" },
        ],
        subject_ids: (block.subject_ids ?? []).includes(id)
          ? (block.subject_ids ?? [])
          : [...(block.subject_ids ?? []), id],
      };
    }));

    setBlockAddSubjectPopupBlockId(null);
    setBlockAddSubjectName("");
    setStatusText(`Added blokkfag subject card ${name} to block ${targetBlock.name || targetBlock.id}.`);
  }

  function addTeachersToSubject(subject: Subject, teacherIdsToAdd: string[]) {
    if (subject.subject_type === "programfag") {
      const normalizedTeacherIdsToAdd = Array.from(new Set(teacherIdsToAdd.filter(Boolean)));
      if (!normalizedTeacherIdsToAdd.length) {
        return;
      }

      const hasBlockEntry = blocks.some((block) =>
        (block.subject_entries ?? []).some((entry) => entry.subject_id === subject.id)
      );

      const mergedTeacherIds = Array.from(new Set([
        ...getProgramfagTeacherIdsFromBlocks(subject.id),
        ...getSubjectTeacherIds(subject),
        ...normalizedTeacherIdsToAdd,
      ]));

      if (hasBlockEntry) {
        setBlocks((prev) => prev.map((block) => ({
          ...block,
          subject_entries: (block.subject_entries ?? []).map((entry) =>
            entry.subject_id === subject.id
              ? {
                  ...entry,
                  teacher_id: mergedTeacherIds[0] ?? "",
                  teacher_ids: mergedTeacherIds,
                }
              : entry
          ),
        })));
      }

      updateSubjectCard(subject.id, {
        teacher_id: mergedTeacherIds[0] ?? "",
        teacher_ids: mergedTeacherIds,
      });
      return;
    }

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
    if (subject.subject_type === "programfag") {
      const currentIds = Array.from(new Set([
        ...getProgramfagTeacherIdsFromBlocks(subject.id),
        ...getSubjectTeacherIds(subject),
      ]));
      const nextTeacherIds = currentIds.filter((teacherId) => teacherId !== teacherIdToRemove);
      const replacementTeacherId = nextTeacherIds[0] ?? "";

      const hasBlockEntry = blocks.some((block) =>
        (block.subject_entries ?? []).some((entry) => entry.subject_id === subject.id)
      );

      if (hasBlockEntry) {
        setBlocks((prev) => prev.map((block) => ({
          ...block,
          subject_entries: (block.subject_entries ?? []).map((entry) =>
            entry.subject_id === subject.id
              ? {
                  ...entry,
                  teacher_id: replacementTeacherId,
                  teacher_ids: nextTeacherIds,
                }
              : entry
          ),
        })));
        updateSubjectCard(subject.id, {
          teacher_id: replacementTeacherId,
          teacher_ids: nextTeacherIds,
        });
        return;
      }
    }

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
    return Object.fromEntries(displayRoomOptions.map((room) => [room.id, room.name])) as Record<string, string>;
  }, [displayRoomOptions]);

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

  const faggrupperClassColumns = useMemo(() => {
    const startsWithDigit = (value: string, digit: "1" | "2" | "3") => value.trim().startsWith(digit);
    return [
      {
        key: "1",
        title: "1",
        classes: filteredFaggrupperClasses.filter((schoolClass) => startsWithDigit(schoolClass.name, "1")),
      },
      {
        key: "2",
        title: "2",
        classes: filteredFaggrupperClasses.filter((schoolClass) => startsWithDigit(schoolClass.name, "2")),
      },
      {
        key: "3",
        title: "3",
        classes: filteredFaggrupperClasses.filter((schoolClass) => startsWithDigit(schoolClass.name, "3")),
      },
    ];
  }, [filteredFaggrupperClasses]);

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

  const teacherFilterSubjectSummaryRows = useMemo(() => {
    const subjectToBlockInfoLocal = new Map<string, { block_id: string; block_name: string; class_ids: string[] }>();
    for (const block of blocks) {
      for (const entry of block.subject_entries ?? []) {
        subjectToBlockInfoLocal.set(entry.subject_id, {
          block_id: block.id,
          block_name: block.name,
          class_ids: block.class_ids ?? [],
        });
      }
      for (const subject_id of block.subject_ids ?? []) {
        subjectToBlockInfoLocal.set(subject_id, {
          block_id: block.id,
          block_name: block.name,
          class_ids: block.class_ids ?? [],
        });
      }
    }

    const sortedTeacherIds = [...selectedTeacherCompareIds].sort((a, b) => {
      const aName = teacherNameById[a] ?? a;
      const bName = teacherNameById[b] ?? b;
      return aName.localeCompare(bName, "nb");
    });

    return sortedTeacherIds.map((teacherId) => {
      type Entry = { kind: "Blokk" | "Class"; label: string; subject: string; subjectId: string };
      const entryByKey = new Map<string, Entry>();

      for (const item of displaySchedule) {
        const itemTeacherIds = Array.from(new Set([
          ...(item.teacher_id ? [item.teacher_id] : []),
          ...(item.teacher_ids ?? []),
        ].filter(Boolean)));
        if (!itemTeacherIds.includes(teacherId)) {
          continue;
        }

        const blockInfo = subjectToBlockInfoLocal.get(item.subject_id);
        if (blockInfo) {
          const label = blockInfo.block_name || blockInfo.block_id;
          const key = `B|${label}|${item.subject_id}`;
          entryByKey.set(key, { kind: "Blokk", label, subject: item.subject_name, subjectId: item.subject_id });
          continue;
        }

        const classIds = item.class_ids?.length ? item.class_ids : [""];
        for (const classId of classIds) {
          const label = classNameById[classId] ?? classId ?? "Unknown";
          const key = `C|${label}|${item.subject_id}`;
          entryByKey.set(key, { kind: "Class", label, subject: item.subject_name, subjectId: item.subject_id });
        }
      }

      const entries = Array.from(entryByKey.values()).sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "Blokk" ? -1 : 1;
        }
        const labelCmp = a.label.localeCompare(b.label, "nb");
        if (labelCmp !== 0) {
          return labelCmp;
        }
        return a.subject.localeCompare(b.subject, "nb");
      });

      return {
        teacherId,
        teacherName: teacherNameById[teacherId] ?? teacherId,
        entries,
      };
    });
  }, [selectedTeacherCompareIds, teacherNameById, displaySchedule, classNameById, blocks]);

  const overviewSubjectToBlockId = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      for (const entry of block.subject_entries ?? []) {
        map.set(entry.subject_id, block.id);
      }
      for (const subjectId of block.subject_ids ?? []) {
        map.set(subjectId, block.id);
      }
    }
    return map;
  }, [blocks]);

  const overviewBlockWeekTypeBySlot = useMemo(() => {
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

  const overviewWeekSplitByRoomKeys = useMemo(() => {
    type WeekRooms = { a: Set<string>; b: Set<string> };
    const buckets = new Map<string, WeekRooms>();

    for (const item of schedule) {
      if (item.week_type !== "A" && item.week_type !== "B") {
        continue;
      }

      const classKey = [...(item.class_ids ?? [])].sort().join(",");
      const key = [
        item.subject_id,
        item.teacher_id,
        item.timeslot_id,
        item.day,
        String(item.period),
        classKey,
      ].join("|");
      const bucket = buckets.get(key) ?? { a: new Set<string>(), b: new Set<string>() };
      const roomKey = item.room_id ?? "";
      if (item.week_type === "A") {
        bucket.a.add(roomKey);
      } else {
        bucket.b.add(roomKey);
      }
      buckets.set(key, bucket);
    }

    const splitKeys = new Set<string>();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.a.size === 0 || bucket.b.size === 0) {
        continue;
      }
      const aRooms = Array.from(bucket.a).sort().join("|");
      const bRooms = Array.from(bucket.b).sort().join("|");
      if (aRooms !== bRooms) {
        splitKeys.add(key);
      }
    }

    return splitKeys;
  }, [schedule]);

  const overviewScheduleItems = useMemo(() => {
    if (!enableAlternatingWeeks || weekView === "both") {
      return displaySchedule;
    }
    return displaySchedule.filter((item) => {
      const blockId = overviewSubjectToBlockId.get(item.subject_id);
      const weekSplitKey = [
        item.subject_id,
        item.teacher_id,
        item.timeslot_id,
        item.day,
        String(item.period),
        [...(item.class_ids ?? [])].sort().join(","),
      ].join("|");
      const shouldUseSolvedWeekType = overviewWeekSplitByRoomKeys.has(weekSplitKey);
      const effectiveWeekType = blockId
        ? (shouldUseSolvedWeekType
          ? item.week_type
          : overviewBlockWeekTypeBySlot.get(`${blockId}|${item.timeslot_id}`))
        : item.week_type;
      return !effectiveWeekType || effectiveWeekType === weekView;
    });
  }, [displaySchedule, enableAlternatingWeeks, overviewBlockWeekTypeBySlot, overviewSubjectToBlockId, overviewWeekSplitByRoomKeys, weekView]);

  const overviewColumnsByDay = useMemo(() => {
    return calendarDays.map((day) => ({
      day,
      slots: sortedTimeslots
        .filter((slot) => slot.day === day)
        .sort((a, b) => {
          const startCmp = toMinutes(a.start_time) - toMinutes(b.start_time);
          if (startCmp !== 0) {
            return startCmp;
          }
          return a.period - b.period;
        }),
    }));
  }, [sortedTimeslots]);

  const overviewFlatColumns = useMemo(() => {
    return overviewColumnsByDay.flatMap((group, dayIndex) => (
      group.slots.map((slot) => ({
        day: group.day,
        dayIndex,
        slot,
      }))
    ));
  }, [overviewColumnsByDay]);

  type OverviewDataKind = "rooms" | "teachers" | "classes";
  type OverviewRow = { id: string; label: string };

  const overviewRowsByKind = useMemo<Record<OverviewDataKind, OverviewRow[]>>(() => ({
    rooms: displayRoomOptions.map((room) => ({ id: room.id, label: room.name || room.id })),
    teachers: sortedTeachersByFirstName.map((teacher) => ({ id: teacher.id, label: teacher.name || teacher.id })),
    classes: sortedClasses.map((schoolClass) => ({ id: schoolClass.id, label: schoolClass.name || schoolClass.id })),
  }), [displayRoomOptions, sortedClasses, sortedTeachersByFirstName]);

  const activeOverviewDataKind: OverviewDataKind = activeOverviewSubtab === "rooms"
    ? "rooms"
    : activeOverviewSubtab === "teachers"
      ? "teachers"
      : "classes";

  const overviewRows = useMemo(() => {
    if (activeOverviewSubtab === "constraints") {
      return [];
    }
    return overviewRowsByKind[activeOverviewDataKind];
  }, [activeOverviewDataKind, activeOverviewSubtab, overviewRowsByKind]);

  useEffect(() => {
    const rowIdSet = new Set(overviewRows.map((row) => row.id));
    setOverviewSelectedRowIds((prev) => prev.filter((rowId) => rowIdSet.has(rowId)));
  }, [overviewRows]);

  const overviewFilterValuesByKind = useMemo<Record<OverviewDataKind, string[]>>(() => ({
    classes: parseCommaSeparatedFilterValues(overviewClassFilterQuery),
    teachers: parseCommaSeparatedFilterValues(overviewTeacherFilterQuery),
    rooms: parseCommaSeparatedFilterValues(overviewRoomFilterQuery),
  }), [overviewClassFilterQuery, overviewRoomFilterQuery, overviewTeacherFilterQuery]);

  const overviewAutocompleteOptionsByKind = useMemo<Record<OverviewDataKind, string[]>>(() => ({
    classes: sortedClasses.map((schoolClass) => schoolClass.name).filter(Boolean).sort((a, b) => a.localeCompare(b, "nb")),
    teachers: sortedTeachersByFirstName.map((teacher) => teacher.name).filter(Boolean).sort((a, b) => a.localeCompare(b, "nb")),
    rooms: displayRoomOptions.map((room) => room.name).filter(Boolean).sort((a, b) => a.localeCompare(b, "nb")),
  }), [displayRoomOptions, sortedClasses, sortedTeachersByFirstName]);

  const overviewRowSearchTextByIdByKind = useMemo<Record<OverviewDataKind, Map<string, string>>>(() => {
    const maps: Record<OverviewDataKind, Map<string, string>> = {
      rooms: new Map<string, string>(),
      teachers: new Map<string, string>(),
      classes: new Map<string, string>(),
    };

    for (const kind of ["rooms", "teachers", "classes"] as const) {
      for (const row of overviewRowsByKind[kind]) {
        maps[kind].set(row.id, normalizeSearchText(`${row.label} ${row.id}`));
      }
    }

    return maps;
  }, [overviewRowsByKind]);

  const overviewRowsMatchingQuery = useMemo(() => {
    const activeMap = overviewRowSearchTextByIdByKind[activeOverviewDataKind];
    const activeValues = overviewFilterValuesByKind[activeOverviewDataKind];
    return overviewRows.filter((row) => {
      if (activeValues.length === 0) {
        return true;
      }
      const haystack = activeMap.get(row.id) ?? normalizeSearchText(`${row.label} ${row.id}`);
      return activeValues.some((value) => haystack.includes(value));
    });
  }, [activeOverviewDataKind, overviewFilterValuesByKind, overviewRowSearchTextByIdByKind, overviewRows]);

  const filteredOverviewRows = useMemo(() => {
    if (overviewSelectedRowIds.length === 0) {
      return overviewRowsMatchingQuery;
    }
    const selectedSet = new Set(overviewSelectedRowIds);
    return overviewRowsMatchingQuery.filter((row) => selectedSet.has(row.id));
  }, [overviewRowsMatchingQuery, overviewSelectedRowIds]);

  const supplementalOverviewRows = useMemo(() => {
    const result: Array<{ id: string; label: string; kind: OverviewDataKind }> = [];
    for (const kind of ["rooms", "teachers", "classes"] as const) {
      if (kind === activeOverviewDataKind) {
        continue;
      }
      const values = overviewFilterValuesByKind[kind];
      if (values.length === 0) {
        continue;
      }
      const kindMap = overviewRowSearchTextByIdByKind[kind];
      const matches = overviewRowsByKind[kind].filter((row) => {
        const haystack = kindMap.get(row.id) ?? normalizeSearchText(`${row.label} ${row.id}`);
        return values.some((value) => haystack.includes(value));
      });
      for (const row of matches) {
        result.push({ ...row, kind });
      }
    }
    return result;
  }, [activeOverviewDataKind, overviewFilterValuesByKind, overviewRowSearchTextByIdByKind, overviewRowsByKind]);

  const displayedOverviewRows = useMemo(() => {
    const activeFilterHasValues = overviewFilterValuesByKind[activeOverviewDataKind].length > 0;
    const hasAnyNonActiveFilter = (["rooms", "teachers", "classes"] as const)
      .some((kind) => kind !== activeOverviewDataKind && overviewFilterValuesByKind[kind].length > 0);

    // If user filters by another entity while staying on this tab (e.g. class filter while on Rom),
    // show only those filtered external rows and hide the active-tab base rows.
    const hideActiveRows = !activeFilterHasValues && hasAnyNonActiveFilter;

    const mainRows = hideActiveRows
      ? []
      : filteredOverviewRows.map((row) => ({ ...row, kind: activeOverviewDataKind, supplemental: false }));
    const existingIds = new Set(mainRows.map((row) => `${row.kind}|${row.id}`));
    const extraRows = supplementalOverviewRows
      .filter((row) => !existingIds.has(`${row.kind}|${row.id}`))
      .map((row) => ({ ...row, supplemental: true }));
    return [...mainRows, ...extraRows];
  }, [activeOverviewDataKind, filteredOverviewRows, overviewFilterValuesByKind, supplementalOverviewRows]);

  const overviewHasActiveFiltering = useMemo(() => {
    const hasQueryFilters = (Object.keys(overviewFilterValuesByKind) as OverviewDataKind[])
      .some((kind) => overviewFilterValuesByKind[kind].length > 0);
    return hasQueryFilters || overviewSelectedRowIds.length > 0;
  }, [overviewFilterValuesByKind, overviewSelectedRowIds.length]);

  const overviewEntityLabel = activeOverviewSubtab === "rooms"
    ? "Rom"
    : activeOverviewSubtab === "teachers"
      ? "Lærer"
      : activeOverviewSubtab === "constraints"
        ? "Begrensning"
        : "Klasse";

  const sortedSubjectsByName = useMemo(() => {
    return [...subjects].sort((a, b) => a.name.localeCompare(b.name));
  }, [subjects]);

  const teachersWithCustomRoomConstraints = useMemo(() => {
    return sortedTeachersByFirstName.filter((teacher) => (
      (teacher.room_requirement_mode ?? "always") !== "always"
      || (teacher.preferred_room_ids ?? []).some((roomId) => rooms.some((room) => room.id === roomId))
    ));
  }, [rooms, sortedTeachersByFirstName]);

  const teachersWithUnavailableTimes = useMemo(() => {
    return sortedTeachersByFirstName.filter((teacher) => teacher.unavailable_timeslots.length > 0);
  }, [sortedTeachersByFirstName]);

  const subjectsWithCustomRoomConstraints = useMemo(() => {
    return sortedSubjectsByName.filter((subject) => (
      (subject.room_requirement_mode ?? "always") !== "always"
      || (subject.preferred_room_ids ?? []).some((roomId) => rooms.some((room) => room.id === roomId))
    ));
  }, [rooms, sortedSubjectsByName]);

  const overviewCellMapsByKind = useMemo(() => {
    type OverviewCellEntry = {
      key: string;
      title: string;
      subtitle: string;
      teacher_label?: string;
      match_signature?: string;
      hover_subject_key?: string;
      week_type?: "A" | "B";
      isMeeting?: boolean;
    };

    const maps: Record<OverviewDataKind, Map<string, OverviewCellEntry[]>> = {
      rooms: new Map<string, OverviewCellEntry[]>(),
      teachers: new Map<string, OverviewCellEntry[]>(),
      classes: new Map<string, OverviewCellEntry[]>(),
    };

    const addEntry = (kind: OverviewDataKind, entityId: string, timeslotId: string, entry: OverviewCellEntry) => {
      const cellKey = `${entityId}|${timeslotId}`;
      const current = maps[kind].get(cellKey) ?? [];
      if (current.some((existing) => existing.key === entry.key)) {
        return;
      }
      current.push(entry);
      current.sort((a, b) => a.title.localeCompare(b.title));
      maps[kind].set(cellKey, current);
    };

    const formatTeacherNames = (teacherIds: string[]) => {
      if (teacherIds.length === 0) {
        return "";
      }
      return teacherIds.map((teacherId) => teacherNameById[teacherId] ?? teacherId).join(", ");
    };

    for (const item of overviewScheduleItems) {
      if (!overviewFlatColumns.some((column) => column.slot.id === item.timeslot_id)) {
        continue;
      }

      const itemTeacherIds = Array.from(new Set([
        ...(item.teacher_id ? [item.teacher_id] : []),
        ...(item.teacher_ids ?? []),
      ].filter(Boolean)));
      const teacherNames = formatTeacherNames(itemTeacherIds);
      const classNames = (item.class_ids ?? []).map((classId) => classNameById[classId] ?? classId).join(", ");
      const roomName = item.room_id ? (roomNameById[item.room_id] ?? item.room_id) : "";
      const blockId = overviewSubjectToBlockId.get(item.subject_id);
      const weekSplitKey = [
        item.subject_id,
        item.teacher_id,
        item.timeslot_id,
        item.day,
        String(item.period),
        [...(item.class_ids ?? [])].sort().join(","),
      ].join("|");
      const shouldUseSolvedWeekType = overviewWeekSplitByRoomKeys.has(weekSplitKey);
      const effectiveWeekType = blockId
        ? (shouldUseSolvedWeekType
          ? item.week_type
          : overviewBlockWeekTypeBySlot.get(`${blockId}|${item.timeslot_id}`))
        : item.week_type;
      const canonicalSessionSignature = [
        item.subject_id,
        [...itemTeacherIds].sort().join(","),
        [...(item.class_ids ?? [])].sort().join(","),
        item.room_id ?? "",
        effectiveWeekType ?? "both",
        item.start_time ?? "",
        item.end_time ?? "",
      ].join("|");
      const hoverSubjectKey = `${item.subject_id}|${[...(item.class_ids ?? [])].sort().join(",")}`;

      if (item.room_id) {
        addEntry("rooms", item.room_id, item.timeslot_id, {
          key: `${item.subject_id}|${item.teacher_id}|${item.class_ids.join(",")}|${effectiveWeekType ?? "both"}|${item.start_time ?? ""}|${item.end_time ?? ""}`,
          title: item.subject_name,
          subtitle: classNames || teacherNames,
          teacher_label: teacherNames,
          match_signature: canonicalSessionSignature,
          hover_subject_key: hoverSubjectKey,
          week_type: effectiveWeekType,
        });
      }

      for (const teacherId of itemTeacherIds) {
        const teacherLabel = teacherNameById[teacherId] ?? teacherId;
        addEntry("teachers", teacherId, item.timeslot_id, {
          key: `${item.subject_id}|${teacherId}|${item.class_ids.join(",")}|${item.room_id ?? ""}|${effectiveWeekType ?? "both"}|${item.start_time ?? ""}|${item.end_time ?? ""}`,
          title: item.subject_name,
          subtitle: [classNames, roomName].filter(Boolean).join(" | "),
          teacher_label: teacherLabel,
          match_signature: canonicalSessionSignature,
          hover_subject_key: hoverSubjectKey,
          week_type: effectiveWeekType,
        });
      }

      for (const classId of item.class_ids ?? []) {
        addEntry("classes", classId, item.timeslot_id, {
          key: `${item.subject_id}|${classId}|${item.teacher_id}|${item.room_id ?? ""}|${effectiveWeekType ?? "both"}|${item.start_time ?? ""}|${item.end_time ?? ""}`,
          title: item.subject_name,
          subtitle: [teacherNames, roomName].filter(Boolean).join(" | "),
          teacher_label: teacherNames,
          match_signature: canonicalSessionSignature,
          hover_subject_key: hoverSubjectKey,
          week_type: effectiveWeekType,
        });
      }
    }

    for (const meeting of meetings) {
      if (!overviewFlatColumns.some((column) => column.slot.id === meeting.timeslot_id)) {
        continue;
      }
      for (const assignment of meeting.teacher_assignments) {
        addEntry("teachers", assignment.teacher_id, meeting.timeslot_id, {
          key: `meeting|${meeting.id}|${assignment.teacher_id}`,
          title: `Møte: ${meeting.name}`,
          subtitle: assignment.mode === "unavailable" ? "Opptatt" : "Prioritert",
          teacher_label: teacherNameById[assignment.teacher_id] ?? assignment.teacher_id,
          isMeeting: true,
        });
      }
    }

    return maps;
  }, [
    classNameById,
    meetings,
    overviewBlockWeekTypeBySlot,
    overviewFlatColumns,
    overviewScheduleItems,
    overviewSubjectToBlockId,
    overviewWeekSplitByRoomKeys,
    roomNameById,
    teacherNameById,
  ]);

  const overviewMatchedSubjectBySlot = useMemo(() => {
    const rowsBySlotAndSignature = new Map<string, Set<string>>();

    const addOccurrence = (timeslotId: string, signature: string, rowKey: string) => {
      const key = `${timeslotId}|${signature}`;
      const set = rowsBySlotAndSignature.get(key) ?? new Set<string>();
      set.add(rowKey);
      rowsBySlotAndSignature.set(key, set);
    };

    for (const row of displayedOverviewRows) {
      const map = overviewCellMapsByKind[row.kind];
      const rowKey = `${row.kind}|${row.id}`;
      for (const column of overviewFlatColumns) {
        const rawEntries = map.get(`${row.id}|${column.slot.id}`) ?? [];
        for (const entry of rawEntries) {
          if (entry.isMeeting) {
            continue;
          }
          if (!entry.match_signature) {
            continue;
          }
          addOccurrence(column.slot.id, entry.match_signature, rowKey);
        }
      }
    }

    const matched = new Set<string>();
    for (const [key, rowKeys] of rowsBySlotAndSignature.entries()) {
      if (rowKeys.size >= 2) {
        matched.add(key);
      }
    }

    return matched;
  }, [displayedOverviewRows, overviewCellMapsByKind, overviewFlatColumns]);

  const overviewHoverSubjectSlotIds = useMemo(() => {
    if (!overviewHoverSubjectKey) {
      return new Set<string>();
    }
    const slotIds = new Set<string>();

    for (const row of displayedOverviewRows) {
      const map = overviewCellMapsByKind[row.kind];
      for (const column of overviewFlatColumns) {
        const rawEntries = map.get(`${row.id}|${column.slot.id}`) ?? [];
        if (rawEntries.some((entry) => !entry.isMeeting && entry.hover_subject_key === overviewHoverSubjectKey)) {
          slotIds.add(column.slot.id);
        }
      }
    }

    return slotIds;
  }, [displayedOverviewRows, overviewCellMapsByKind, overviewFlatColumns, overviewHoverSubjectKey]);

  const overviewHoverSubjectStatus = useMemo(() => {
    if (!overviewHoverSubjectKey) {
      return null;
    }

    const occurrences = new Set<string>();
    let subjectTitle = "";

    for (const row of displayedOverviewRows) {
      const map = overviewCellMapsByKind[row.kind];
      for (const column of overviewFlatColumns) {
        const rawEntries = map.get(`${row.id}|${column.slot.id}`) ?? [];
        for (const entry of rawEntries) {
          if (entry.isMeeting || entry.hover_subject_key !== overviewHoverSubjectKey) {
            continue;
          }
          if (!subjectTitle) {
            subjectTitle = entry.title;
          }
          const timeRange = `${column.slot.start_time ?? `P${column.slot.period}`}${column.slot.end_time ? `-${column.slot.end_time}` : ""}`;
          const rowTypeLabel = row.kind === "teachers" ? "Lærer" : row.kind === "classes" ? "Klasse" : "Rom";
          occurrences.add(`${column.day} ${timeRange} (${rowTypeLabel}: ${row.label})`);
        }
      }
    }

    const list = Array.from(occurrences);
    if (list.length === 0) {
      return null;
    }
    const maxItems = 6;
    const shown = list.slice(0, maxItems);
    const suffix = list.length > maxItems ? ` +${list.length - maxItems} til` : "";

    return {
      subjectTitle,
      text: `${shown.join(" | ")}${suffix}`,
    };
  }, [displayedOverviewRows, overviewCellMapsByKind, overviewFlatColumns, overviewHoverSubjectKey]);

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

  // Subjects tab only shows templates: fellesfag templates + blokkfag (stored as programfag).
  // For each template, derive which classes are assigned via per-class copies.
  const subjectTabEntries = useMemo<SubjectTabEntry[]>(() => {
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

  const fellesfagSubjectTabEntries = useMemo(
    () => subjectTabEntries.filter(({ subject }) => subject.subject_type === "fellesfag"),
    [subjectTabEntries]
  );

  const blokkfagSubjectTabEntries = useMemo(
    () => subjectTabEntries.filter(({ subject }) => subject.subject_type === "programfag"),
    [subjectTabEntries]
  );

  const blokkfagGroupsByBlock = useMemo<BlokkfagGroup[]>(() => {
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const blockIdBySubjectId = new Map<string, string>();

    for (const block of blocks) {
      for (const entry of block.subject_entries ?? []) {
        if (!blockIdBySubjectId.has(entry.subject_id)) {
          blockIdBySubjectId.set(entry.subject_id, block.id);
        }
      }
      for (const subjectId of block.subject_ids ?? []) {
        if (!blockIdBySubjectId.has(subjectId)) {
          blockIdBySubjectId.set(subjectId, block.id);
        }
      }
    }

    const grouped = new Map<string, SubjectTabEntry[]>();
    const unassigned: SubjectTabEntry[] = [];

    for (const entry of blokkfagSubjectTabEntries) {
      const blockId = blockIdBySubjectId.get(entry.subject.id);
      if (!blockId) {
        unassigned.push(entry);
        continue;
      }

      const list = grouped.get(blockId) ?? [];
      list.push(entry);
      grouped.set(blockId, list);
    }

    const groups = Array.from(grouped.entries())
      .map(([blockId, entries]) => ({
        key: blockId,
        title: blockById.get(blockId)?.name ?? blockId,
        entries: entries.sort((a, b) => a.subject.name.localeCompare(b.subject.name)),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    if (unassigned.length > 0) {
      groups.push({
        key: "unassigned",
        title: "Unassigned",
        entries: unassigned.sort((a, b) => a.subject.name.localeCompare(b.subject.name)),
      });
    }

    return groups;
  }, [blokkfagSubjectTabEntries, blocks]);

  const blockNamesBySubjectId = useMemo(() => {
    const namesBySubject = new Map<string, Set<string>>();
    for (const block of blocks) {
      const blockName = (block.name || block.id).trim() || block.id;
      const linkedSubjectIds = new Set<string>([
        ...((block.subject_entries ?? []).map((entry) => entry.subject_id).filter(Boolean)),
        ...((block.subject_ids ?? []).filter(Boolean)),
      ]);
      for (const subjectId of linkedSubjectIds) {
        if (!namesBySubject.has(subjectId)) {
          namesBySubject.set(subjectId, new Set<string>());
        }
        namesBySubject.get(subjectId)!.add(blockName);
      }
    }

    const normalized = new Map<string, string[]>();
    namesBySubject.forEach((names, subjectId) => {
      normalized.set(subjectId, Array.from(names).sort((a, b) => a.localeCompare(b)));
    });
    return normalized;
  }, [blocks]);

  const blokkfagGroupsBySubject = useMemo<BlokkfagGroup[]>(() => {
    const grouped = new Map<string, BlokkfagGroup>();

    for (const entry of blokkfagSubjectTabEntries) {
      const trimmedName = entry.subject.name.trim();
      const normalizedName = trimmedName.toLocaleLowerCase();
      const key = normalizedName || `subject:${entry.subject.id}`;
      const title = trimmedName || "Unnamed Subject";

      const existing = grouped.get(key);
      if (existing) {
        existing.entries.push(entry);
        continue;
      }

      grouped.set(key, {
        key,
        title,
        entries: [entry],
      });
    }

    return Array.from(grouped.values())
      .map((group) => {
        const blockNameSet = new Set<string>();
        for (const entry of group.entries) {
          const names = blockNamesBySubjectId.get(entry.subject.id) ?? [];
          for (const name of names) {
            blockNameSet.add(name);
          }
        }

        return {
          ...group,
          entries: group.entries.sort((a, b) => a.subject.id.localeCompare(b.subject.id)),
          blockNames: Array.from(blockNameSet).sort((a, b) => a.localeCompare(b)),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [blokkfagSubjectTabEntries, blockNamesBySubjectId]);

  const blokkfagDisplayedGroups = useMemo<BlokkfagGroup[]>(() => {
    if (blokkfagSortMode === "subject") {
      return blokkfagGroupsBySubject;
    }
    return blokkfagGroupsByBlock;
  }, [blokkfagSortMode, blokkfagGroupsBySubject, blokkfagGroupsByBlock]);

  const sortedBlocksByName = useMemo(() => {
    return [...blocks].sort((a, b) => a.name.localeCompare(b.name));
  }, [blocks]);

  const timelineMarks = useMemo(() => {
    const mondaySlots = [...(timeslotsByDay["Monday"] ?? [])].sort((a, b) => {
      const startCmp = toMinutes(a.start_time) - toMinutes(b.start_time);
      if (startCmp !== 0) {
        return startCmp;
      }
      return toMinutes(a.end_time) - toMinutes(b.end_time);
    });

    const marksSet = new Set<number>([DAY_START_MINUTES, DAY_END_MINUTES]);
    for (const slot of mondaySlots) {
      const start = toMinutes(slot.start_time);
      const end = toMinutes(slot.end_time);
      if (start !== Number.MAX_SAFE_INTEGER && start >= DAY_START_MINUTES && start <= DAY_END_MINUTES) {
        marksSet.add(start);
      }
      if (end !== Number.MAX_SAFE_INTEGER && end >= DAY_START_MINUTES && end <= DAY_END_MINUTES) {
        marksSet.add(end);
      }
    }

    return Array.from(marksSet).sort((a, b) => a - b);
  }, [timeslotsByDay]);

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
    if (!expandedSubjectId || activeTab !== "subjects") {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const cardRoot = target.closest(`[data-subject-card-root="${expandedSubjectId}"]`);
      if (!cardRoot) {
        setExpandedSubjectId(null);
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [expandedSubjectId, activeTab]);

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

  const timelineWeekSplitByRoomKeys = useMemo(() => {
    type WeekRooms = { a: Set<string>; b: Set<string> };
    const buckets = new Map<string, WeekRooms>();

    for (const item of schedule) {
      if (item.week_type !== "A" && item.week_type !== "B") {
        continue;
      }

      const classKey = [...(item.class_ids ?? [])].sort().join(",");
      const key = [
        item.subject_id,
        item.teacher_id,
        item.timeslot_id,
        item.day,
        String(item.period),
        classKey,
      ].join("|");
      const bucket = buckets.get(key) ?? { a: new Set<string>(), b: new Set<string>() };
      const roomKey = item.room_id ?? "";
      if (item.week_type === "A") {
        bucket.a.add(roomKey);
      } else {
        bucket.b.add(roomKey);
      }
      buckets.set(key, bucket);
    }

    const splitKeys = new Set<string>();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.a.size === 0 || bucket.b.size === 0) {
        continue;
      }
      const aRooms = Array.from(bucket.a).sort().join("|");
      const bRooms = Array.from(bucket.b).sort().join("|");
      if (aRooms !== bRooms) {
        splitKeys.add(key);
      }
    }

    return splitKeys;
  }, [schedule]);

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
        preferred_room_ids: [],
        room_requirement_mode: teacherForm.room_requirement_mode,
      },
    ]);
    setTeacherForm({
      name: "",
      unavailable_timeslots: "",
      workload_percent: "100",
      room_requirement_mode: "always",
    });
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
            preferred_room_ids: [],
            room_requirement_mode: "always",
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
    const setupId = classForm.setupId || getDefaultSetupId();
    if (setupId) {
      assignClassesToSetup([id], setupId);
    }
    setClassForm({ name: "", setupId: "" });
  }

  function getDefaultSetupId(): string {
    if (activeWeekSetupId && weekCalendarSetups.some((setup) => setup.id === activeWeekSetupId)) {
      return activeWeekSetupId;
    }
    return weekCalendarSetups[0]?.id ?? "";
  }

  function assignClassesToSetup(classIds: string[], setupId: string) {
    if (!classIds.length) {
      return;
    }

    const resolvedSetupId =
      setupId ||
      (activeWeekSetupId && weekCalendarSetups.some((setup) => setup.id === activeWeekSetupId)
        ? activeWeekSetupId
        : (weekCalendarSetups[0]?.id ?? ""));

    if (!resolvedSetupId) {
      return;
    }

    setWeekCalendarSetups((prev) => prev.map((setup) => {
      const filtered = setup.class_ids.filter((id) => !classIds.includes(id));
      if (setup.id === resolvedSetupId) {
        return { ...setup, class_ids: Array.from(new Set([...filtered, ...classIds])) };
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

    setSubjects((prev) => prev.flatMap((subject) => {
      const cleanedClassIds = subject.class_ids.filter((id) => id !== classId);

      // Drop only per-class fellesfag copies that belonged exclusively to the deleted class.
      const isDeletedClassFellesfagCopy =
        subject.subject_type === "fellesfag" &&
        subject.class_ids.length === 1 &&
        subject.class_ids[0] === classId;

      if (isDeletedClassFellesfagCopy) {
        return [];
      }

      return [{
        ...subject,
        class_ids: cleanedClassIds,
      }];
    }));

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

    const setupId = bulkClassForm.setupId || getDefaultSetupId();
    if (setupId) {
      assignClassesToSetup(
        toAdd.map((c) => c.id),
        setupId,
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
    if (weekCalendarSetups.length <= 1) {
      setStatusText("At least one setup is required. You cannot delete the last setup.");
      return;
    }

    const setupToDelete = weekCalendarSetups.find((setup) => setup.id === setupId);
    const fallbackSetup =
      weekCalendarSetups.find((setup) => setup.id !== setupId && setup.id === activeWeekSetupId) ||
      weekCalendarSetups.find((setup) => setup.id !== setupId);

    if (!fallbackSetup) {
      setStatusText("Could not find a replacement setup.");
      return;
    }

    const classesToReassign = setupToDelete?.class_ids ?? [];

    setWeekCalendarSetups((prev) => prev
      .filter((setup) => setup.id !== setupId)
      .map((setup) => (
        setup.id === fallbackSetup.id
          ? { ...setup, class_ids: Array.from(new Set([...setup.class_ids, ...classesToReassign])) }
          : setup
      )));

    if (activeWeekSetupId === setupId) {
      setActiveWeekSetupId(fallbackSetup.id);
      setWeekSetupForm({ name: fallbackSetup.name });
    }
    if (renamingWeekSetupId === setupId) {
      setRenamingWeekSetupId(null);
      setRenameDraft("");
    }
    setStatusText(`Deleted week setup ${setupId}.`);
  }

  function getSetupIdForClass(classId: string): string {
    const found = weekCalendarSetups.find((setup) => setup.class_ids.includes(classId));
    return found?.id ?? getDefaultSetupId();
  }

  function assignClassToSetup(classId: string, setupId: string) {
    const resolvedSetupId = setupId || getDefaultSetupId();
    if (!resolvedSetupId) {
      setStatusText("Create a week setup first.");
      return;
    }

    const className = classes.find((c) => c.id === classId)?.name ?? classId;
    assignClassesToSetup([classId], resolvedSetupId);

    const target = weekCalendarSetups.find((setup) => setup.id === resolvedSetupId);
    setStatusText(`Assigned class ${className} to ${target?.name ?? resolvedSetupId}.`);
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

  function addOrCreateFellesfagForClass(classId: string) {
    const className = classes.find((c) => c.id === classId)?.name ?? classId;
    const rawName = newFellesfagNameByClass[classId] ?? "";
    const requestedName = rawName.trim();
    if (!requestedName) {
      setStatusText("Enter a fellesfag name first.");
      return;
    }

    const normalizedRequestedName = requestedName.toLocaleLowerCase();
    let action: string = "reused-and-added";

    setSubjects((prev) => {
      const existingTemplate = prev.find((subject) => (
        subject.subject_type === "fellesfag" &&
        subject.class_ids.length !== 1 &&
        subject.name.trim().toLocaleLowerCase() === normalizedRequestedName
      ));

      const alreadyInClass = prev.some((subject) => (
        subject.subject_type === "fellesfag" &&
        subject.class_ids.length === 1 &&
        subject.class_ids[0] === classId &&
        subject.name.trim().toLocaleLowerCase() === normalizedRequestedName
      ));

      if (alreadyInClass) {
        action = "already-in-class";
        return prev;
      }

      let next = [...prev];
      let template: Subject;

      if (existingTemplate) {
        template = existingTemplate;
        action = "reused-and-added";
      } else {
        const templateId = makeUniqueId(
          `subject_${toSlug(requestedName) || "item"}`,
          next.map((subject) => subject.id),
        );

        template = {
          id: templateId,
          name: requestedName,
          teacher_id: "",
          teacher_ids: [],
          class_ids: [],
          subject_type: "fellesfag",
          sessions_per_week: 1,
          force_place: false,
          preferred_room_ids: [],
          room_requirement_mode: "always",
        };
        next = [...next, template];
        action = "created-and-added";
      }

      const copyId = makeUniqueId(
        `subject_${toSlug(template.name) || "item"}_${toSlug(className) || "class"}`,
        next.map((subject) => subject.id),
      );
      const copy: Subject = {
        ...template,
        id: copyId,
        class_ids: [classId],
      };

      return [...next, copy];
    });

    if (action === "already-in-class") {
      setStatusText(`${requestedName} is already assigned to ${className}.`);
      return;
    }

    setNewFellesfagNameByClass((prev) => ({
      ...prev,
      [classId]: "",
    }));

    if (action === "created-and-added") {
      setStatusText(`Created new fellesfag ${requestedName} and added it to ${className}.`);
      return;
    }

    setStatusText(`Added fellesfag ${requestedName} to ${className} from existing templates.`);
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


  function createAndAddSubjectToSavedBlock(blockId: string) {
    const name = (blockInlineSubjNames[blockId] ?? "").trim();
    if (!name) return;
    const block = blocks.find((b) => b.id === blockId);
    const occurrenceCount = blockOccurrenceSessionCount(block?.occurrences);
    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((s) => s.id));
    // alternating_week_split removed - auto-balancing is used instead
    setSubjects((prev) => [...prev, { id, name, teacher_id: "", teacher_ids: [], class_ids: [], subject_type: "programfag", sessions_per_week: occurrenceCount }]);
    autoAssignSubjectIdsToSportsHalls([id], name);
    setBlocks((prev) => prev.map((b) =>
      b.id !== blockId ? b : {
        ...b,
        subject_entries: b.subject_entries.some((se) => se.subject_id === id)
          ? b.subject_entries
          : [...b.subject_entries, { subject_id: id, teacher_id: "", teacher_ids: [], preferred_room_id: "" }],
      }
    ));
    setBlockInlineSubjNames((prev) => ({ ...prev, [blockId]: "" }));
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
    setSubjects((prev) => prev.map((subject) => {
      const nextAllowed = (subject.allowed_block_ids ?? []).filter((id) => id !== blockId);
      return {
        ...subject,
        allowed_block_ids: nextAllowed.length > 0 ? nextAllowed : undefined,
      };
    }));
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

    const isBlokkfag = subjectForm.subject_type === "programfag";
    const selectedBlockId = subjectForm.block_id;
    const selectedClassIds = subjectForm.subject_type === "fellesfag"
      ? Array.from(new Set(subjectForm.class_ids))
      : [];
    if (isBlokkfag && sortedBlocksByName.length > 0 && !selectedBlockId) {
      setStatusText("Select a block for the blokkfag subject.");
      return;
    }

    const id = makeUniqueId(`subject_${toSlug(name) || "item"}`, subjects.map((s) => s.id));
    const createdSubjectIds: string[] = [];
    let addedClassCopies = 0;
    let skippedClassCopies = 0;
    setSubjects((prev) => {
      const template: Subject = {
        id,
        name,
        teacher_id: "",
        teacher_ids: [],
        class_ids: [],
        subject_type: subjectForm.subject_type,
        sessions_per_week: 1,
        force_place: false,
        allowed_block_ids: isBlokkfag && selectedBlockId ? [selectedBlockId] : undefined,
        preferred_room_ids: [],
        room_requirement_mode: "always",
      };
      createdSubjectIds.push(template.id);

      let next = [...prev, template];

      if (!isBlokkfag) {
        for (const classId of selectedClassIds) {
          const className = classes.find((c) => c.id === classId)?.name ?? classId;
          const alreadyExists = next.some(
            (s) => s.subject_type === "fellesfag"
              && s.name === template.name
              && s.class_ids.length === 1
              && s.class_ids[0] === classId,
          );
          if (alreadyExists) {
            skippedClassCopies += 1;
            continue;
          }

          const copyId = makeUniqueId(
            `subject_${toSlug(template.name) || "item"}_${toSlug(className) || "class"}`,
            next.map((s) => s.id),
          );
          next = [
            ...next,
            {
              ...template,
              id: copyId,
              class_ids: [classId],
            },
          ];
          createdSubjectIds.push(copyId);
          addedClassCopies += 1;
        }
      }

      return next;
    });
    autoAssignSubjectIdsToSportsHalls(createdSubjectIds, name);

    if (isBlokkfag && selectedBlockId) {
      setBlocks((prev) => prev.map((block) => {
        if (block.id !== selectedBlockId) {
          return block;
        }
        const alreadyLinked = (block.subject_entries ?? []).some((entry) => entry.subject_id === id);
        return {
          ...block,
          subject_entries: alreadyLinked
            ? (block.subject_entries ?? [])
            : [
                ...(block.subject_entries ?? []),
                { subject_id: id, teacher_id: "", teacher_ids: [], preferred_room_id: "" },
              ],
          subject_ids: (block.subject_ids ?? []).includes(id)
            ? (block.subject_ids ?? [])
            : [...(block.subject_ids ?? []), id],
        };
      }));
    }

    setSubjectForm((prev) => ({
      ...prev,
      name: "",
      class_ids: [],
    }));

    if (isBlokkfag) {
      const blockName = sortedBlocksByName.find((block) => block.id === selectedBlockId)?.name ?? selectedBlockId;
      setStatusText(
        selectedBlockId
          ? `Added blokkfag subject card ${name} to block ${blockName}.`
          : `Added blokkfag subject card ${name}.`,
      );
      return;
    }
    if (addedClassCopies > 0 || skippedClassCopies > 0) {
      setStatusText(
        `Added fellesfag subject card ${name}. Added to ${addedClassCopies} class(es)`
        + (skippedClassCopies > 0 ? `, skipped ${skippedClassCopies} existing.` : "."),
      );
      return;
    }
    setStatusText(`Added fellesfag subject card ${name}.`);
  }

  function updateSubjectCard(subjectId: string, patch: Partial<Subject>) {
    setSubjects((prev) => {
      const target = prev.find((subject) => subject.id === subjectId);
      if (!target) {
        return prev;
      }

      const oldName = target.name;
      const oldType = target.subject_type;
      const hasNamePatch = typeof patch.name === "string";
      const nextName: string = hasNamePatch ? patch.name as string : oldName;
      const shouldPropagateName =
        hasNamePatch &&
        nextName !== oldName;
      const hasRoomModePatch = Object.prototype.hasOwnProperty.call(patch, "room_requirement_mode");
      const hasPreferredRoomsPatch = Object.prototype.hasOwnProperty.call(patch, "preferred_room_ids");
      const shouldPropagateRoomSettings =
        target.subject_type === "fellesfag" && (hasRoomModePatch || hasPreferredRoomsPatch);

      return prev.map((subject) => {
        const isTarget = subject.id === subjectId;
        const isPerClassCopyOfTarget =
          shouldPropagateName &&
          subject.id !== subjectId &&
          subject.subject_type === oldType &&
          subject.name === oldName &&
          subject.class_ids.length === 1;
        const isFellesfagFamilyForRoomSettings =
          shouldPropagateRoomSettings &&
          subject.id !== subjectId &&
          subject.subject_type === "fellesfag" &&
          subject.name === oldName;

        if (!isTarget && !isPerClassCopyOfTarget && !isFellesfagFamilyForRoomSettings) {
          return subject;
        }

        const merged = isTarget
          ? { ...subject, ...patch, name: nextName }
          : isFellesfagFamilyForRoomSettings
            ? {
                ...subject,
                room_requirement_mode: hasRoomModePatch
                  ? (patch.room_requirement_mode === "once_per_week" ? "once_per_week" : "always")
                  : subject.room_requirement_mode,
                preferred_room_ids: hasPreferredRoomsPatch
                  ? (Array.isArray(patch.preferred_room_ids) ? patch.preferred_room_ids.filter(Boolean) : [])
                  : subject.preferred_room_ids,
              }
          : { ...subject, name: nextName };
        const cleanedClassIds = merged.class_ids.filter((id) => classes.some((c) => c.id === id));
        const mergedTeacherIds = Array.from(new Set([
          ...(typeof merged.teacher_id === "string" && merged.teacher_id.trim() ? [merged.teacher_id.trim()] : []),
          ...(Array.isArray(merged.teacher_ids)
            ? merged.teacher_ids.map((id) => String(id).trim()).filter(Boolean)
            : []),
        ]));
        return {
          ...merged,
          name: merged.name ?? "",
          teacher_id: mergedTeacherIds[0] ?? "",
          teacher_ids: mergedTeacherIds,
          class_ids: cleanedClassIds,
          sessions_per_week: Math.max(1, Math.floor(merged.sessions_per_week || 1)),
          link_group_id:
            typeof merged.link_group_id === "string" && merged.link_group_id.trim()
              ? merged.link_group_id.trim()
              : undefined,
        };
      });
    });
  }

  function setFellesfagLinkEnabled(subjectId: string, enabled: boolean) {
    setSubjects((prev) => {
      const target = prev.find((subject) => subject.id === subjectId);
      if (!target || target.subject_type !== "fellesfag" || target.class_ids.length !== 1) {
        return prev;
      }

      const normalizedName = target.name.trim().toLocaleLowerCase();
      const family = prev.filter((subject) => (
        subject.subject_type === "fellesfag" &&
        subject.name.trim().toLocaleLowerCase() === normalizedName
      ));
      if (!family.length) {
        return prev;
      }

      const existingGroupId = family
        .map((subject) => (typeof subject.link_group_id === "string" ? subject.link_group_id.trim() : ""))
        .find(Boolean);
      const nextGroupId = enabled
        ? (existingGroupId || `link_${toSlug(target.name) || "fellesfag"}_${Date.now().toString(36)}`)
        : undefined;

      return prev.map((subject) => {
        const isSameFamily =
          subject.subject_type === "fellesfag" &&
          subject.name.trim().toLocaleLowerCase() === normalizedName;
        if (!isSameFamily) {
          return subject;
        }
        return {
          ...subject,
          link_group_id: nextGroupId,
        };
      });
    });

    setStatusText(enabled ? "Linked matching fellesfag copies to the same timeslots." : "Removed fellesfag link for matching copies.");
  }

  function getExcludedTimeslotsForSubject(subject: Subject): string[] {
    const allSlotIds = sortedTimeslots.map((slot) => slot.id);
    if (!subject.allowed_timeslots) {
      return [];
    }

    const allowed = new Set(subject.allowed_timeslots);
    return allSlotIds.filter((slotId) => !allowed.has(slotId));
  }

  function updateFellesfagExcludedTimeslots(
    subjectId: string,
    excludedSlotIds: string[],
    propagateToClassCopies: boolean = true,
  ) {
    const excluded = new Set(excludedSlotIds);
    const allowed = sortedTimeslots
      .map((slot) => slot.id)
      .filter((slotId) => !excluded.has(slotId));

    setSubjects((prev) => {
      const target = prev.find((subject) => subject.id === subjectId);
      if (!target) {
        return prev;
      }

      const nextAllowed = excluded.size === 0 ? undefined : allowed;

      return prev.map((subject) => {
        const isTarget = subject.id === subjectId;
        const isPerClassCopy =
          propagateToClassCopies &&
          target.subject_type === "fellesfag" &&
          subject.id !== subjectId &&
          subject.subject_type === "fellesfag" &&
          subject.class_ids.length === 1 &&
          subject.name === target.name;

        if (!isTarget && !isPerClassCopy) {
          return subject;
        }

        return {
          ...subject,
          allowed_timeslots: nextAllowed,
        };
      });
    });
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
    setPlacementWarningDetails([]);
    setPlacementWarningSummary("");
    setUnplacedStatusDetails([]);
    setUnplacedStatusSummary("");
    setSchedule([]);

    try {
      const blockReferencedSubjectIds = new Set<string>([
        ...(blocks ?? []).flatMap((block) => block.subject_ids ?? []),
        ...(blocks ?? []).flatMap((block) => (block.subject_entries ?? []).map((entry) => entry.subject_id)),
      ]);

      const fellesfagRoomTemplateByName = new Map<string, { preferred_room_ids: string[]; room_requirement_mode: "always" | "once_per_week" }>();
      for (const subject of subjects) {
        if (subject.subject_type !== "fellesfag") {
          continue;
        }
        if ((subject.class_ids ?? []).length !== 0) {
          continue;
        }
        const preferred = Array.isArray(subject.preferred_room_ids) ? subject.preferred_room_ids.filter(Boolean) : [];
        const mode: "always" | "once_per_week" = subject.room_requirement_mode === "once_per_week" ? "once_per_week" : "always";
        if (preferred.length === 0 && mode === "always") {
          continue;
        }
        const key = subject.name.trim().toLocaleLowerCase();
        if (!key || fellesfagRoomTemplateByName.has(key)) {
          continue;
        }
        fellesfagRoomTemplateByName.set(key, {
          preferred_room_ids: preferred,
          room_requirement_mode: mode,
        });
      }

      // Ensure all arrays are properly defined
      const cleanSubjects: Subject[] = subjects
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
        .map((s) => {
          const ownPreferred = Array.isArray(s.preferred_room_ids) ? s.preferred_room_ids.filter(Boolean) : [];
          const ownMode: "always" | "once_per_week" = s.room_requirement_mode === "once_per_week" ? "once_per_week" : "always";
          let effectivePreferred = ownPreferred;
          let effectiveMode = ownMode;

          if (s.subject_type === "fellesfag" && (s.class_ids ?? []).length === 1 && ownPreferred.length === 0 && ownMode === "always") {
            const inherited = fellesfagRoomTemplateByName.get(s.name.trim().toLocaleLowerCase());
            if (inherited) {
              effectivePreferred = inherited.preferred_room_ids;
              effectiveMode = inherited.room_requirement_mode;
            }
          }

          return {
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
            link_group_id:
              typeof s.link_group_id === "string" && s.link_group_id.trim()
                ? s.link_group_id.trim()
                : undefined,
            preferred_room_ids: effectivePreferred,
            room_requirement_mode: effectiveMode,
          };
        });

      const payload = {
        subjects: cleanSubjects,
        teachers: teachers ?? [],
        meetings: meetings ?? [],
        rooms: rooms ?? [],
        sports_halls: sportsHalls ?? [],
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
        } catch { /* ignore parse failure */ }
        throw new Error(detail);
      }

      const data: GenerateResponse = await res.json();
      const canShowPlacementWarnings = data.status === "success" && (data.schedule?.length ?? 0) > 0;
      const blockLinkedSubjectIds = new Set<string>([
        ...payload.blocks.flatMap((block) => (block.subject_ids ?? []).filter(Boolean)),
        ...payload.blocks.flatMap((block) => (block.subject_entries ?? []).map((entry) => entry.subject_id).filter(Boolean)),
      ]);
      if (canShowPlacementWarnings) {
        const warningDetails = collectPlacementWarningDetails(
          data,
          cleanSubjects,
          timeslots,
          blockLinkedSubjectIds,
          enableAlternatingWeeks,
        );
        const failedWeeks = getFailedWeeksFromMetadata(data.metadata);
        if (warningDetails.length > 0) {
          const weekLabel = failedWeeks.join(" + ");
          setPlacementWarningSummary(
            `${weekLabel}-week is below preferred units for ${warningDetails.length} subject${warningDetails.length === 1 ? "" : "s"}.`,
          );
        }
        setPlacementWarningDetails(warningDetails);
      } else {
        setPlacementWarningSummary("");
        setPlacementWarningDetails([]);
      }

      const unplacedDetails = collectUnplacedStatusDetails(
        data,
        cleanSubjects,
        timeslots,
        blockLinkedSubjectIds,
        enableAlternatingWeeks,
        Object.fromEntries(teachers.map((teacher) => [teacher.id, teacher.name])) as Record<string, string>,
      );
      setUnplacedStatusDetails(unplacedDetails);
      if (unplacedDetails.length > 0) {
        setUnplacedStatusSummary(
          `${unplacedDetails.length} subject${unplacedDetails.length === 1 ? "" : "s"} have unplaced units.`,
        );
      } else {
        setUnplacedStatusSummary("");
      }

      setStatusText(formatGeneratedScheduleStatus(data, runId));
      setSchedule(data.schedule || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setPlacementWarningDetails([]);
      setPlacementWarningSummary("");
      setUnplacedStatusDetails([]);
      setUnplacedStatusSummary("");
      setStatusText(`Failed (run ${runId}): ${message}`);
    } finally {
      setLoading(false);
    }
  }

  function clearGeneratedSchedule() {
    setSchedule([]);
    setPlacementWarningDetails([]);
    setPlacementWarningSummary("");
    setUnplacedStatusDetails([]);
    setUnplacedStatusSummary("");
    setStatusText("Generated schedule cleared. Inputs and constraints are unchanged.");
  }

  const renderSubjectCards = (
    entries: SubjectTabEntry[],
    emptyText: string,
    options?: { showProgramfagBlockNames?: boolean },
  ) => {
    if (entries.length === 0) {
      return <p className="subject-column-empty">{emptyText}</p>;
    }

    return entries.map(({ subject, derivedClassIds }) => {
      const assignedBlockId = subject.subject_type === "programfag"
        ? getProgramfagBlockId(subject.id)
        : "";
      const assignedTeacherIds = subject.subject_type === "programfag"
        ? getProgramfagTeacherIdsFromBlocks(subject.id)
        : getSubjectTeacherIds(subject);
      const assignedTeacherNames = assignedTeacherIds.map((teacherId) => teacherNameById[teacherId] ?? teacherId);
      const blokkfagTeacherSummary = assignedTeacherNames.length === 0
        ? "No teacher assigned"
        : assignedTeacherNames.length <= 2
          ? assignedTeacherNames.join(", ")
          : `${assignedTeacherNames.slice(0, 2).join(", ")} +${assignedTeacherNames.length - 2}`;
      const searchKey = `subjects_${subject.id}`;
      const teacherDraft = teacherSearchBySubjectEntity[searchKey] ?? "";
      const excludedTimeslots = subject.subject_type === "fellesfag"
        ? getExcludedTimeslotsForSubject(subject)
        : [];
      const excludedSearchKey = `exclude_subjects_${subject.id}`;
      const excludedDraft = excludedSessionSearchBySubjectEntity[excludedSearchKey] ?? "";
      const preferredRoomIds = Array.from(new Set((subject.preferred_room_ids ?? []).filter((roomId) => rooms.some((room) => room.id === roomId))));
      const roomSearchKey = `rooms_subjects_${subject.id}`;
      const roomDraft = roomSearchBySubjectEntity[roomSearchKey] ?? "";
      const programfagBlockNames = subject.subject_type === "programfag"
        ? (blockNamesBySubjectId.get(subject.id) ?? [])
        : [];

      return (
      <article
        key={subject.id}
        className={`item subject-card-item${expandedSubjectId === subject.id ? " expanded" : ""}`}
        data-subject-card-root={subject.id}
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
              {subject.subject_type === "fellesfag"
                ? `Fellesfag (${subject.sessions_per_week}x45)`
                : blokkfagTeacherSummary}
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
            {options?.showProgramfagBlockNames && subject.subject_type === "programfag" && (
              <span className="subject-expand-meta">
                Blocks: {programfagBlockNames.length > 0 ? programfagBlockNames.join(", ") : "Unassigned"}
              </span>
            )}
          </span>
          <span className="subject-expand-symbol">{expandedSubjectId === subject.id ? "-" : "+"}</span>
        </button>

        {expandedSubjectId === subject.id && (
          <div className="subject-expand-panel">
            {options?.showProgramfagBlockNames && subject.subject_type === "programfag" && (
              <div className="subject-block-assignment-row">
                <span className="subject-teacher-section-title">Blocks</span>
                <span className="subject-block-assignment-text">
                  {programfagBlockNames.length > 0 ? programfagBlockNames.join(", ") : "Unassigned"}
                </span>
              </div>
            )}
            <div className="subject-card-grid">
              <div className="calendar-field subject-name-field">
                <label>Subject Name</label>
                <input
                  type="text"
                  value={subject.name}
                  onChange={(e) =>
                    updateSubjectCard(subject.id, {
                      name: e.target.value,
                    })
                  }
                  placeholder="Subject name"
                />
              </div>

              {subject.subject_type === "fellesfag" && (
                <div className="calendar-field subject-sessions-field">
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
              )}

              <div className={`subject-type-stack${subject.subject_type === "fellesfag" ? " with-sessions" : ""}`}>
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
                    <option value="programfag">Blokkfag</option>
                  </select>
                </div>
              </div>

              {subject.subject_type === "programfag" && (
                <div className="calendar-field subject-block-field">
                  <label>Assigned Block</label>
                  <select
                    value={assignedBlockId}
                    onChange={(e) => assignProgramfagToBlock(subject.id, e.target.value)}
                    disabled={sortedBlocksByName.length === 0}
                  >
                    <option value="">Unassigned</option>
                    {sortedBlocksByName.map((block) => (
                      <option key={block.id} value={block.id}>
                        {block.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {subject.subject_type === "fellesfag" && (
                <details className="calendar-field excluded-session-field excluded-session-row subject-collapsible">
                  <summary className="subject-collapsible-summary">Excluded Sessions</summary>
                  <div className="subject-collapsible-body">
                    <div className="faggrupper-teacher-add-row">
                      <input
                        list={`excluded-session-options-subject-${subject.id}`}
                        value={excludedDraft}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          const resolvedTimeslotId = resolveTimeslotIdFromInput(nextValue);
                          if (resolvedTimeslotId) {
                            if (!excludedTimeslots.includes(resolvedTimeslotId)) {
                              updateFellesfagExcludedTimeslots(subject.id, [...excludedTimeslots, resolvedTimeslotId]);
                            }
                            setExcludedSessionSearchBySubjectEntity((prev) => ({
                              ...prev,
                              [excludedSearchKey]: "",
                            }));
                            return;
                          }

                          setExcludedSessionSearchBySubjectEntity((prev) => ({
                            ...prev,
                            [excludedSearchKey]: nextValue,
                          }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") {
                            return;
                          }
                          e.preventDefault();
                          const resolvedTimeslotIds = resolveTimeslotIdsFromInput(excludedDraft);
                          if (resolvedTimeslotIds === null) {
                            setStatusText("Could not resolve one or more sessions. Use exact labels from the list.");
                            return;
                          }
                          if (resolvedTimeslotIds.length === 0) {
                            return;
                          }
                          const nextSet = new Set(excludedTimeslots);
                          for (const tsId of resolvedTimeslotIds) {
                            nextSet.add(tsId);
                          }
                          updateFellesfagExcludedTimeslots(subject.id, Array.from(nextSet));
                          setExcludedSessionSearchBySubjectEntity((prev) => ({
                            ...prev,
                            [excludedSearchKey]: "",
                          }));
                        }}
                        placeholder="Search session(s), comma-separated"
                      />
                    </div>
                    <div className="faggrupper-teacher-selected excluded-session-selected" style={{ marginTop: "0.35rem", maxHeight: "118px", overflowY: "auto", alignContent: "flex-start" }}>
                      {excludedTimeslots.length === 0 ? (
                        <span className="faggrupper-teacher-empty">No excluded sessions</span>
                      ) : (
                        excludedTimeslots.map((slotId) => {
                          const slot = timeslotById[slotId];
                          const label = slot ? formatTimeslotLabel(slot) : slotId;
                          return (
                            <span key={`${subject.id}_${slotId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip excluded-session-chip">
                              <span className="excluded-session-chip-label">{label}</span>
                              <button
                                type="button"
                                className="subject-class-chip-remove"
                                onClick={() => {
                                  const next = excludedTimeslots.filter((id) => id !== slotId);
                                  updateFellesfagExcludedTimeslots(subject.id, next);
                                }}
                                aria-label={`Remove excluded slot ${label}`}
                              >
                                x
                              </button>
                            </span>
                          );
                        })
                      )}
                    </div>
                    <datalist id={`excluded-session-options-subject-${subject.id}`}>
                      {filterTimeslotsForQuery(excludedDraft).map((slot) => (
                        <option key={slot.id} value={formatTimeslotLabel(slot)} />
                      ))}
                    </datalist>
                    <small>Force in Fellesfag tab can still place this subject in an excluded session.</small>
                  </div>
                </details>
              )}

              <details className="calendar-field excluded-session-field excluded-session-row subject-collapsible">
                <summary className="subject-collapsible-summary">Room Requirements</summary>
                <div className="subject-collapsible-body">
                  <div className="room-requirements-top-row">
                    <div className="faggrupper-force-field" style={{ minWidth: 0 }}>
                      <label className="faggrupper-force-label">Mode</label>
                      <select
                        value={subject.room_requirement_mode ?? "always"}
                        onChange={(e) => updateSubjectCard(subject.id, {
                          room_requirement_mode: e.target.value === "once_per_week" ? "once_per_week" : "always",
                        })}
                      >
                        <option value="always">Always in selected rooms</option>
                        <option value="once_per_week">At least once per week</option>
                      </select>
                    </div>
                    <div className="faggrupper-teacher-add-row room-requirements-search-row">
                      <input
                        list={`room-options-subject-${subject.id}`}
                        value={roomDraft}
                        onChange={(e) => {
                          const nextValue = e.target.value;
                          const resolvedRoomId = resolveRoomIdFromInput(nextValue);
                          if (resolvedRoomId) {
                            if (!preferredRoomIds.includes(resolvedRoomId)) {
                              updateSubjectCard(subject.id, {
                                preferred_room_ids: [...preferredRoomIds, resolvedRoomId],
                              });
                            }
                            setRoomSearchBySubjectEntity((prev) => ({
                              ...prev,
                              [roomSearchKey]: "",
                            }));
                            return;
                          }

                          setRoomSearchBySubjectEntity((prev) => ({
                            ...prev,
                            [roomSearchKey]: nextValue,
                          }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") {
                            return;
                          }
                          e.preventDefault();
                          const resolvedRoomIds = resolveRoomIdsFromInput(roomDraft);
                          if (resolvedRoomIds === null) {
                            setStatusText("Could not resolve one or more room names. Use exact names from the list.");
                            return;
                          }
                          if (resolvedRoomIds.length === 0) {
                            return;
                          }
                          const nextSet = new Set(preferredRoomIds);
                          for (const roomId of resolvedRoomIds) {
                            nextSet.add(roomId);
                          }
                          updateSubjectCard(subject.id, {
                            preferred_room_ids: Array.from(nextSet),
                          });
                          setRoomSearchBySubjectEntity((prev) => ({
                            ...prev,
                            [roomSearchKey]: "",
                          }));
                        }}
                        placeholder="Search room(s), comma-separated"
                      />
                    </div>
                  </div>
                  <div className="faggrupper-teacher-selected excluded-session-selected" style={{ marginTop: "0.35rem", maxHeight: "98px", overflowY: "auto", alignContent: "flex-start" }}>
                    {preferredRoomIds.length === 0 ? (
                      <span className="faggrupper-teacher-empty">No preferred rooms selected</span>
                    ) : (
                      preferredRoomIds.map((roomId) => {
                        const roomLabel = roomNameById[roomId] ?? roomId;
                        return (
                          <span key={`${subject.id}_${roomId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip excluded-session-chip">
                            <span className="excluded-session-chip-label">{roomLabel}</span>
                            <button
                              type="button"
                              className="subject-class-chip-remove"
                              onClick={() => {
                                updateSubjectCard(subject.id, {
                                  preferred_room_ids: preferredRoomIds.filter((id) => id !== roomId),
                                });
                              }}
                              aria-label={`Remove preferred room ${roomLabel}`}
                            >
                              x
                            </button>
                          </span>
                        );
                      })
                    )}
                  </div>
                  <datalist id={`room-options-subject-${subject.id}`}>
                    {filterRoomsForQuery(roomDraft).map((room) => (
                      <option key={room.id} value={room.name} />
                    ))}
                  </datalist>
                </div>
              </details>

              <div className="calendar-field" style={{ display: "none" }}>
                <label>A/B Week Split (DISABLED - Auto-balancing is used)</label>
                <input
                  type="text"
                  value=""
                  disabled
                  placeholder="e.g. 4/6"
                />
              </div>

            </div>

            {subject.subject_type === "fellesfag" && (
              <div className="subject-class-manager">
                <span className="subject-teacher-section-title">Classes With Subject</span>

                <div className="class-toggle-grid-rows">
                  {classRowsByYear.every((row) => row.classes.length === 0) ? (
                    <span className="subject-class-empty">No classes available</span>
                  ) : (
                    classRowsByYear.map((row) => (
                      <div key={`${subject.id}_${row.yearPrefix}`} className="class-toggle-row">
                          <button
                            type="button"
                            className="class-toggle-row-label class-toggle-row-action"
                            onClick={() => {
                              const rowClassIds = row.classes.map((schoolClass) => schoolClass.id);
                              const selectedRowClassIds = rowClassIds.filter((classId) => derivedClassIds.includes(classId));
                              const allSelected = rowClassIds.length > 0 && selectedRowClassIds.length === rowClassIds.length;

                              if (allSelected) {
                                selectedRowClassIds.forEach((classId) => removeSubjectFromClass(subject, classId));
                                return;
                              }

                              rowClassIds
                                .filter((classId) => !derivedClassIds.includes(classId))
                                .forEach((classId) => addSubjectToClass(subject, classId, derivedClassIds));
                            }}
                          >
                            {row.yearPrefix}. trinn
                          </button>
                        <div className="class-toggle-row-buttons">
                          {row.classes.length === 0 ? (
                            <span className="subject-class-empty">No classes</span>
                          ) : (
                            row.classes.map((schoolClass) => {
                              const isSelected = derivedClassIds.includes(schoolClass.id);
                              return (
                                <button
                                  key={`${subject.id}_${schoolClass.id}`}
                                  type="button"
                                  className={`class-toggle-chip ${isSelected ? "on" : "off"}`}
                                  onClick={() => {
                                    if (isSelected) {
                                      removeSubjectFromClass(subject, schoolClass.id);
                                      return;
                                    }
                                    addSubjectToClass(subject, schoolClass.id, derivedClassIds);
                                  }}
                                >
                                  {schoolClass.name}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {subject.subject_type === "programfag" && (
              <div className="subject-teacher-section">
                <span className="subject-teacher-section-title">Assigned Teachers</span>

                <div className="faggrupper-teacher-selected">
                  {assignedTeacherIds.length === 0 ? (
                    <span className="subject-class-empty">No teachers assigned</span>
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

                <div className="faggrupper-teacher-picker">
                  <div className="faggrupper-teacher-add-row">
                    <input
                      list={`subjects-teacher-options-${subject.id}`}
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
                  <datalist id={`subjects-teacher-options-${subject.id}`}>
                    {filterTeachersForQuery(teacherDraft).map((teacher) => (
                      <option key={teacher.id} value={teacher.name} />
                    ))}
                  </datalist>
                </div>
              </div>
            )}

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
        )}
      </article>
      );
    });
  };

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
      </section>

      <section className="tab-strip" aria-label="Workflow tabs">
        {workflowTabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.id === "files" ? 0 : index}</span>
            {tab.label}
          </button>
        ))}
      </section>

      {activeTab === "files" && (
      <section className="grid">
        <article className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Files</h2>
          <p>Export current workspace state to JSON, import a JSON file, and restore earlier exports from this menu.</p>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "12px" }}>
            <button type="button" onClick={() => exportCurrentState()}>
              Export JSON
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => jsonFileRef.current?.click()}
            >
              Import JSON
            </button>
            <input
              ref={jsonFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={handleImportJsonChange}
            />
          </div>

          <h3>Saved Exports</h3>
          <div className="list">
            {savedJsonExports.length === 0 ? (
              <div className="item">No saved exports yet.</div>
            ) : (
              savedJsonExports.map((item) => (
                <div key={item.id} className="item" style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
                  <div>
                    <strong>{item.name}</strong>
                    <div style={{ fontSize: "0.8rem", color: "#5a5a5a" }}>
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button type="button" className="secondary" onClick={() => restoreSavedExport(item)}>
                      Load
                    </button>
                    <button type="button" className="secondary" onClick={() => downloadJsonFile(item.name, item.payload)}>
                      Download
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setSavedJsonExports((prev) => prev.filter((entry) => entry.id !== item.id))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
      )}

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
                      ? setup.class_ids
                        .map((id) => classNameById[id] ?? id)
                        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
                        .join(", ")
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
              <div className="class-toggle-grid-rows">
                {classRowsByYear.every((row) => row.classes.length === 0) ? (
                  <span className="meeting-empty">No classes available</span>
                ) : (
                  classRowsByYear.map((row) => (
                    <div key={row.yearPrefix} className="class-toggle-row">
                      <button
                        type="button"
                        className="class-toggle-row-label class-toggle-row-action"
                        onClick={() => {
                          const rowClassIds = row.classes.map((schoolClass) => schoolClass.id);
                          const allSelected = rowClassIds.length > 0
                            && rowClassIds.every((classId) => timeslotForm.generation_allowed_class_ids.includes(classId));

                          setTimeslotForm((s) => {
                            const current = new Set(s.generation_allowed_class_ids);
                            if (allSelected) {
                              rowClassIds.forEach((classId) => current.delete(classId));
                            } else {
                              rowClassIds.forEach((classId) => current.add(classId));
                            }
                            return {
                              ...s,
                              generation_allowed_class_ids: Array.from(current),
                            };
                          });
                        }}
                      >
                        {row.yearPrefix}. trinn
                      </button>
                      <div className="class-toggle-row-buttons">
                        {row.classes.length === 0 ? (
                          <span className="meeting-empty">No classes</span>
                        ) : (
                          row.classes.map((schoolClass) => {
                            const isSelected = timeslotForm.generation_allowed_class_ids.includes(schoolClass.id);
                            return (
                              <button
                                key={schoolClass.id}
                                type="button"
                                className={`class-toggle-chip ${isSelected ? "on" : "off"}`}
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
                    </div>
                  ))
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
                        className={`slot-pill${slot.excluded_from_generation ? " excluded" : ""}`}
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
                        <div>{slot.start_time} - {slot.end_time}</div>
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
            <label>Calendar Setup</label>
            <select
              value={classForm.setupId || getDefaultSetupId()}
              onChange={(e) => setClassForm((s) => ({ ...s, setupId: e.target.value }))}
            >
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
              <label>Calendar Setup</label>
              <select
                value={bulkClassForm.setupId || getDefaultSetupId()}
                onChange={(e) => setBulkClassForm((s) => ({ ...s, setupId: e.target.value }))}
              >
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
          <section className="subject-add-panel">
            <h3 className="subject-add-panel-title">Add Subject Card</h3>
            <form onSubmit={(e) => { e.preventDefault(); addSubjectCard(); }}>
              <div className="subject-add-inline-row">
                <div className="calendar-field">
                  <label>Subject Name</label>
                  <input
                    value={subjectForm.name}
                    onChange={(e) => setSubjectForm((s) => ({ ...s, name: e.target.value }))}
                    placeholder="Geografi"
                  />
                </div>

                <div className="calendar-field">
                  <label>Subject Type</label>
                  <select
                    value={subjectForm.subject_type}
                    onChange={(e) => {
                      const nextType = e.target.value === "programfag" ? "programfag" : "fellesfag";
                      setSubjectForm((s) => ({
                        ...s,
                        subject_type: nextType,
                        block_id: nextType === "programfag" ? s.block_id : "",
                        class_ids: nextType === "fellesfag" ? s.class_ids : [],
                      }));
                    }}
                  >
                    <option value="fellesfag">Fellesfag</option>
                    <option value="programfag">Blokkfag</option>
                  </select>
                </div>
              </div>

              {subjectForm.subject_type === "fellesfag" && (
                <div className="subject-add-conditional-slot">
                  <label>Classes With Subject</label>
                  <div className="subject-class-toggle-line">
                    {classRowsByYear.every((row) => row.classes.length === 0) ? (
                      <span className="subject-class-empty">No classes available</span>
                    ) : (
                      classRowsByYear.map((row, rowIndex) => (
                        <Fragment key={`add_subject_${row.yearPrefix}`}>
                          {rowIndex > 0 && <span className="subject-class-toggle-divider" aria-hidden="true" />}
                          <div className="subject-class-toggle-group">
                            <button
                              type="button"
                              className="subject-class-toggle-year"
                              onClick={() => {
                                const rowClassIds = row.classes.map((schoolClass) => schoolClass.id);
                                const selectedRowClassIds = rowClassIds.filter((classId) => subjectForm.class_ids.includes(classId));
                                const allSelected = rowClassIds.length > 0 && selectedRowClassIds.length === rowClassIds.length;

                                setSubjectForm((s) => {
                                  const current = new Set(s.class_ids);
                                  if (allSelected) {
                                    rowClassIds.forEach((classId) => current.delete(classId));
                                  } else {
                                    rowClassIds.forEach((classId) => current.add(classId));
                                  }
                                  return {
                                    ...s,
                                    class_ids: Array.from(current),
                                  };
                                });
                              }}
                            >
                              {row.yearPrefix}. trinn
                            </button>
                            {row.classes.length === 0 ? (
                              <span className="subject-class-empty">No classes</span>
                            ) : (
                              row.classes.map((schoolClass) => {
                                const isSelected = subjectForm.class_ids.includes(schoolClass.id);
                                return (
                                  <button
                                    key={`add_subject_${schoolClass.id}`}
                                    type="button"
                                    className={`class-toggle-chip subject-inline-toggle-chip ${isSelected ? "on" : "off"}`}
                                    onClick={() => setSubjectForm((s) => ({
                                      ...s,
                                      class_ids: isSelected
                                        ? s.class_ids.filter((id) => id !== schoolClass.id)
                                        : [...s.class_ids, schoolClass.id],
                                    }))}
                                  >
                                    {schoolClass.name}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </Fragment>
                      ))
                    )}
                  </div>
                  </div>
              )}

              {subjectForm.subject_type === "programfag" && (
                  <div className="subject-add-conditional-slot">
                  <label>Block</label>
                  <select
                    value={subjectForm.block_id}
                    onChange={(e) => setSubjectForm((s) => ({ ...s, block_id: e.target.value }))}
                  >
                    <option value="">Select block</option>
                    {sortedBlocksByName.map((block) => (
                      <option key={block.id} value={block.id}>
                        {block.name}
                      </option>
                    ))}
                  </select>
                  </div>
              )}
              <button type="submit">Add Subject Card</button>
            </form>
          </section>

          <div className="subject-columns">
            <section className="subject-column subject-column-fellesfag">
              <h3 className="subject-column-title">Fellesfag</h3>
              <div className="list subject-card-list subject-card-list-column">
                {renderSubjectCards(fellesfagSubjectTabEntries, "No fellesfag subjects yet.")}
              </div>
            </section>

            <section className="subject-column subject-column-blokkfag">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <h3 className="subject-column-title" style={{ marginBottom: 0 }}>Blokkfag</h3>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setBlokkfagSortMode("block");
                      setBlockAddSubjectPopupBlockId(null);
                      setBlockAddSubjectName("");
                    }}
                    style={{
                      padding: "2px 8px",
                      fontSize: "0.78rem",
                      borderColor: blokkfagSortMode === "block" ? "#2a9d8f" : undefined,
                      color: blokkfagSortMode === "block" ? "#2a9d8f" : undefined,
                    }}
                  >
                    By Block
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setBlokkfagSortMode("subject");
                      setBlockAddSubjectPopupBlockId(null);
                      setBlockAddSubjectName("");
                    }}
                    style={{
                      padding: "2px 8px",
                      fontSize: "0.78rem",
                      borderColor: blokkfagSortMode === "subject" ? "#2a9d8f" : undefined,
                      color: blokkfagSortMode === "subject" ? "#2a9d8f" : undefined,
                    }}
                  >
                    By Subject
                  </button>
                </div>
              </div>
              <div className="list subject-card-list subject-card-list-column">
                {blokkfagDisplayedGroups.length === 0 ? (
                  <p className="subject-column-empty">No blokkfag subjects yet.</p>
                ) : (
                  blokkfagDisplayedGroups.map((group, groupIndex) => {
                    const isSubjectMode = blokkfagSortMode === "subject";
                    const isCollapsible = isSubjectMode && group.entries.length > 1;
                    const isExpanded = !isCollapsible || expandedBlokkfagSubjectGroups.has(group.key);
                    const toneClass = groupIndex % 2 === 0 ? "subject-block-group-tone-even" : "subject-block-group-tone-odd";
                    const isRealBlockGroup = !isSubjectMode && group.key !== "unassigned";
                    const isAddPopupOpen = isRealBlockGroup && blockAddSubjectPopupBlockId === group.key;

                    return (
                      <section
                        key={group.key}
                        className={`subject-block-group ${isSubjectMode ? "subject-block-group-subject" : "subject-block-group-block"} ${toneClass}`}
                      >
                        {isCollapsible ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setExpandedBlokkfagSubjectGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.key)) {
                                  next.delete(group.key);
                                } else {
                                  next.add(group.key);
                                }
                                return next;
                              });
                            }}
                            style={{ width: "100%", textAlign: "left", fontSize: "0.84rem", padding: "4px 8px" }}
                          >
                            {isExpanded ? "▼" : "▶"} {group.title} ({group.entries.length})
                            {isSubjectMode && (
                              <span className="subject-group-blocks-inline">
                                {' '}| Blocks: {group.blockNames && group.blockNames.length > 0 ? group.blockNames.join(", ") : "Unassigned"}
                              </span>
                            )}
                          </button>
                        ) : (
                          <div className="subject-block-group-header">
                            <h4 className="subject-block-group-title">
                              {group.title}
                              {isSubjectMode && (
                                <span className="subject-group-blocks-inline">
                                  {' '}| Blocks: {group.blockNames && group.blockNames.length > 0 ? group.blockNames.join(", ") : "Unassigned"}
                                </span>
                              )}
                            </h4>
                            {isRealBlockGroup ? (
                              <div className="subject-block-group-actions">
                                <button
                                  type="button"
                                  className="secondary subject-block-add-button"
                                  onClick={() => {
                                    if (isAddPopupOpen) {
                                      setBlockAddSubjectPopupBlockId(null);
                                      setBlockAddSubjectName("");
                                      return;
                                    }
                                    setBlockAddSubjectPopupBlockId(group.key);
                                    setBlockAddSubjectName("");
                                  }}
                                >
                                  Add Subject
                                </button>
                              </div>
                            ) : null}
                          </div>
                        )}
                        {isAddPopupOpen ? (
                          <div className="subject-block-add-popup" role="dialog" aria-label={`Add subject to ${group.title}`}>
                            <label>New subject name for {group.title}</label>
                            <input
                              type="text"
                              value={blockAddSubjectName}
                              onChange={(e) => setBlockAddSubjectName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addSubjectToBlockFromPopup(group.key);
                                }
                              }}
                              placeholder="Write subject name"
                              autoFocus
                            />
                            <div className="subject-block-add-popup-actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => {
                                  setBlockAddSubjectPopupBlockId(null);
                                  setBlockAddSubjectName("");
                                }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => addSubjectToBlockFromPopup(group.key)}
                                disabled={!blockAddSubjectName.trim()}
                              >
                                Add
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {isExpanded && renderSubjectCards(
                          group.entries,
                          isSubjectMode ? "No subjects with this name." : "No subjects in this block.",
                          { showProgramfagBlockNames: isSubjectMode }
                        )}
                      </section>
                    );
                  })
                )}
              </div>
            </section>
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
              <div className="faggrupper-class-columns">
                {faggrupperClassColumns.map((column) => (
                  <section key={column.key} className="faggrupper-class-column">
                    <div className="faggrupper-class-column-list">
                      {column.classes.map((schoolClass) => (
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
                    </div>
                  </section>
                ))}
              </div>
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
                        const excludedTimeslots = getExcludedTimeslotsForSubject(subject);
                        const excludedSearchKey = `exclude_faggrupper_${subject.id}`;
                        const excludedDraft = excludedSessionSearchBySubjectEntity[excludedSearchKey] ?? "";
                        const isClassCopy =
                          subject.class_ids.length === 1 &&
                          subject.class_ids[0] === activeFaggruppeClassId;
                        return (
                          <div key={`${activeFaggruppeClassId}_${subject.id}`} className="subject-teacher-row faggrupper-subject-row">
                            <div className="faggrupper-subject-main">
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
                                className="faggrupper-units-field"
                                title={
                                  isClassCopy && subject.subject_type === "fellesfag"
                                    ? "Linked copies with the same name are scheduled in the same sessions."
                                    : "Only class-specific fellesfag copies can be linked here."
                                }
                              >
                                <label className="faggrupper-force-label">
                                  <input
                                    type="checkbox"
                                    checked={Boolean(subject.link_group_id)}
                                    disabled={!isClassCopy || subject.subject_type !== "fellesfag"}
                                    onChange={(e) => {
                                      setFellesfagLinkEnabled(subject.id, e.target.checked);
                                    }}
                                  />
                                  Link
                                </label>
                              </div>
                            </div>

                            <div className="faggrupper-teacher-picker faggrupper-teacher-picker-inline">
                              <div className="faggrupper-teacher-inline-row">
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
                              </div>
                            </div>

                            <details className="faggrupper-advanced-settings">
                              <summary>Force and Excluded</summary>
                              <div className="faggrupper-advanced-grid">
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

                                <div
                                  className="faggrupper-units-field excluded-session-field"
                                  title={
                                    isClassCopy && subject.subject_type === "fellesfag"
                                      ? "Exclude slots from feasible placement for this class copy."
                                      : "Only class-specific fellesfag copies can be edited here."
                                  }
                                >
                                  <label>Excluded</label>
                                  <div className="faggrupper-teacher-add-row">
                                    <input
                                      list={`excluded-session-options-faggrupper-${activeFaggruppeClassId}-${subject.id}`}
                                      value={excludedDraft}
                                      disabled={!isClassCopy || subject.subject_type !== "fellesfag"}
                                      onChange={(e) => {
                                        const nextValue = e.target.value;
                                        const resolvedTimeslotId = resolveTimeslotIdFromInput(nextValue);
                                        if (resolvedTimeslotId) {
                                          if (!excludedTimeslots.includes(resolvedTimeslotId)) {
                                            updateFellesfagExcludedTimeslots(subject.id, [...excludedTimeslots, resolvedTimeslotId], false);
                                          }
                                          setExcludedSessionSearchBySubjectEntity((prev) => ({
                                            ...prev,
                                            [excludedSearchKey]: "",
                                          }));
                                          return;
                                        }

                                        setExcludedSessionSearchBySubjectEntity((prev) => ({
                                          ...prev,
                                          [excludedSearchKey]: nextValue,
                                        }));
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key !== "Enter") {
                                          return;
                                        }
                                        e.preventDefault();
                                        const resolvedTimeslotIds = resolveTimeslotIdsFromInput(excludedDraft);
                                        if (resolvedTimeslotIds === null) {
                                          setStatusText("Could not resolve one or more sessions. Use exact labels from the list.");
                                          return;
                                        }
                                        if (resolvedTimeslotIds.length === 0) {
                                          return;
                                        }
                                        const nextSet = new Set(excludedTimeslots);
                                        for (const tsId of resolvedTimeslotIds) {
                                          nextSet.add(tsId);
                                        }
                                        updateFellesfagExcludedTimeslots(subject.id, Array.from(nextSet), false);
                                        setExcludedSessionSearchBySubjectEntity((prev) => ({
                                          ...prev,
                                          [excludedSearchKey]: "",
                                        }));
                                      }}
                                      placeholder="Search session(s), comma-separated"
                                    />
                                  </div>
                                  <div className="faggrupper-teacher-selected excluded-session-selected" style={{ marginTop: "0.18rem" }}>
                                    {excludedTimeslots.length === 0 ? (
                                      <span className="faggrupper-teacher-empty">No excluded sessions</span>
                                    ) : (
                                      excludedTimeslots.map((slotId) => {
                                        const slot = timeslotById[slotId];
                                        const label = slot ? formatTimeslotLabel(slot) : slotId;
                                        return (
                                          <span key={`${subject.id}_${slotId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip excluded-session-chip">
                                            <span className="excluded-session-chip-label">{label}</span>
                                            <button
                                              type="button"
                                              className="subject-class-chip-remove"
                                              disabled={!isClassCopy || subject.subject_type !== "fellesfag"}
                                              onClick={() => {
                                                const next = excludedTimeslots.filter((id) => id !== slotId);
                                                updateFellesfagExcludedTimeslots(subject.id, next, false);
                                              }}
                                              aria-label={`Remove excluded slot ${label}`}
                                            >
                                              x
                                            </button>
                                          </span>
                                        );
                                      })
                                    )}
                                  </div>
                                </div>
                              </div>
                            </details>

                            <datalist id={`excluded-session-options-faggrupper-${activeFaggruppeClassId}-${subject.id}`}>
                              {filterTimeslotsForQuery(excludedDraft).map((ts) => (
                                <option key={ts.id} value={formatTimeslotLabel(ts)} />
                              ))}
                            </datalist>
                            <datalist id={`faggrupper-teacher-options-${activeFaggruppeClassId}-${subject.id}`}>
                              {filterTeachersForQuery(teacherDraft).map((teacher) => (
                                <option key={teacher.id} value={teacher.name} />
                              ))}
                            </datalist>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="calendar-field" style={{ marginTop: "0.55rem" }}>
                    <label>Add Fellesfag To This Class</label>
                    <div className="class-setup-controls" style={{ marginBottom: "0.38rem" }}>
                      <select
                        value={fellesfagSelectionByClass[activeFaggruppeClassId] ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          setFellesfagSelectionByClass((prev) => ({
                            ...prev,
                            [activeFaggruppeClassId]: value,
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
                        onClick={() => addFellesfagToClass(activeFaggruppeClassId, fellesfagSelectionByClass[activeFaggruppeClassId] ?? "")}
                        disabled={!fellesfagSelectionByClass[activeFaggruppeClassId]}
                      >
                        Add Existing
                      </button>
                    </div>
                    <div className="class-setup-controls">
                      <input
                        value={newFellesfagNameByClass[activeFaggruppeClassId] ?? ""}
                        onChange={(e) => setNewFellesfagNameByClass((prev) => ({
                          ...prev,
                          [activeFaggruppeClassId]: e.target.value,
                        }))}
                        placeholder="Or create new fellesfag"
                      />
                      <button
                        type="button"
                        onClick={() => addOrCreateFellesfagForClass(activeFaggruppeClassId)}
                        disabled={!(newFellesfagNameByClass[activeFaggruppeClassId] ?? "").trim()}
                      >
                        Add New
                      </button>
                    </div>
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
      <section className="grid blocks-layout">
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
            <div className="block-class-grid">
              {sortedClasses.length === 0 ? (
                <span style={{ fontSize: "0.85em", color: "#999" }}>No classes added yet.</span>
              ) : (
                (["1", "2", "3"] as const).map((yearPrefix) => (
                  <div key={yearPrefix} className="block-class-col">
                    {sortedClasses
                      .filter((cls) => cls.name.startsWith(yearPrefix))
                      .map((cls) => (
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
                      ))}
                  </div>
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

        <article className="card blocks-right-column">
          <h2>Block List</h2>
          {blocks.length === 0 ? (
            <p style={{ color: "#999" }}>No blocks added yet.</p>
          ) : (
            <div className="list" style={{ maxHeight: "600px" }}>
              {sortedBlocksByName.map((block) => {
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
                            {occ.day} {occ.start_time}–{occ.end_time} ({occ.week_type === "both" ? "A+B" : occ.week_type})
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
                            const teacherDraft = teacherSearchBySubjectEntity[searchKey] ?? "";
                            const assignedTeacherIds = Array.from(new Set([
                              ...(se.teacher_id ? [se.teacher_id] : []),
                              ...(se.teacher_ids ?? []),
                            ].filter(Boolean)));
                            return (
                              <div key={se.subject_id} className="subject-teacher-row block-subject-row" style={{ background: "#fafafa", borderRadius: "4px", padding: "4px 8px" }}>
                                <span className="subject-teacher-classname" style={{ fontSize: "0.85em", fontWeight: 600 }}>
                                  {subj?.name ?? se.subject_id}
                                </span>
                                <div className="block-subject-row-controls">
                                  <div className="faggrupper-teacher-selected" style={{ marginBottom: "0.25rem" }}>
                                    {assignedTeacherIds.length === 0 ? (
                                      <span className="faggrupper-teacher-empty">No teachers</span>
                                    ) : (
                                      assignedTeacherIds.map((teacherId) => (
                                        <span key={`${se.subject_id}_${teacherId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip">
                                          {teacherNameById[teacherId] ?? teacherId}
                                          <button
                                            type="button"
                                            className="subject-class-chip-remove"
                                            onClick={() => {
                                              const nextTeacherIds = assignedTeacherIds.filter((id) => id !== teacherId);
                                              updateBlockSubjectEntry(block.id, se.subject_id, {
                                                teacher_id: nextTeacherIds[0] ?? "",
                                                teacher_ids: nextTeacherIds,
                                              });
                                              updateSubjectCard(se.subject_id, {
                                                teacher_id: nextTeacherIds[0] ?? "",
                                                teacher_ids: nextTeacherIds,
                                              });
                                            }}
                                            aria-label={`Remove teacher ${teacherNameById[teacherId] ?? teacherId}`}
                                          >
                                            x
                                          </button>
                                        </span>
                                      ))
                                    )}
                                  </div>
                                  <div className="faggrupper-teacher-picker block-subject-teacher-picker">
                                    <input
                                      className="block-subject-teacher-input"
                                      list={`block-teacher-opts-${block.id}-${se.subject_id}`}
                                      value={getTeacherInputValue(searchKey, se.teacher_id, se.teacher_ids ?? [])}
                                      onChange={(e) => {
                                        const nextValue = e.target.value;
                                        const resolvedTeacherId = resolveTeacherIdFromInput(nextValue);
                                        if (resolvedTeacherId) {
                                          const mergedTeacherIds = Array.from(new Set([
                                            ...assignedTeacherIds,
                                            resolvedTeacherId,
                                          ]));
                                          updateBlockSubjectEntry(block.id, se.subject_id, {
                                            teacher_id: mergedTeacherIds[0] ?? "",
                                            teacher_ids: mergedTeacherIds,
                                          });
                                          updateSubjectCard(se.subject_id, {
                                            teacher_id: mergedTeacherIds[0] ?? "",
                                            teacher_ids: mergedTeacherIds,
                                          });
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

                                        const mergedTeacherIds = Array.from(new Set([
                                          ...assignedTeacherIds,
                                          ...resolvedTeacherIds,
                                        ]));

                                        updateBlockSubjectEntry(block.id, se.subject_id, {
                                          teacher_id: mergedTeacherIds[0] ?? "",
                                          teacher_ids: mergedTeacherIds,
                                        });
                                        updateSubjectCard(se.subject_id, {
                                          teacher_id: mergedTeacherIds[0] ?? "",
                                          teacher_ids: mergedTeacherIds,
                                        });
                                        setTeacherSearchBySubjectEntity((prev) => ({
                                          ...prev,
                                          [searchKey]: "",
                                        }));
                                      }}
                                      placeholder="Assign teacher(s), comma separated"
                                      style={{ fontSize: "0.85em" }}
                                    />
                                    <datalist id={`block-teacher-opts-${block.id}-${se.subject_id}`}>
                                      {filterTeachersForQuery(teacherDraft).map((t) => (
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

          <section className="room-add-panel">
            <div className="room-add-controls">
              <input
                type="text"
                className="room-add-input"
                placeholder="Room name(s) - separate multiple with commas (e.g., R202, R203, R204)"
                value={roomForm.name}
                onChange={(e) => setRoomForm({ name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") upsertRoom(); }}
              />
              <button
                type="button"
                className="room-add-button"
                onClick={() => {
                  upsertRoom();
                }}
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
                  className="secondary room-add-cancel"
                >
                  Cancel
                </button>
              )}
            </div>
            <div className="list room-list" style={{ maxHeight: "288px" }}>
              {sortedRooms.length === 0 ? (
                <p className="meeting-empty">No rooms added yet.</p>
              ) : (
                sortedRooms.map((room) => (
                  <div key={room.id} className="room-list-item">
                    <span>{room.name}</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => openRoomPreferences(room)}
                        style={{
                          padding: "4px 8px",
                          fontSize: "0.72em",
                          background: room.prioritize_for_preferred_subjects ? "#2f7f4f" : undefined,
                          borderColor: room.prioritize_for_preferred_subjects ? "#2f7f4f" : undefined,
                          color: room.prioritize_for_preferred_subjects ? "#fff" : undefined,
                        }}
                      >
                        Preferences
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => loadRoomIntoForm(room)}
                        style={{ padding: "4px 8px", fontSize: "0.72em" }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => deleteRoom(room.id)}
                        style={{ padding: "4px 8px", fontSize: "0.72em", color: "#c53" }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {preferencesRoomId && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(10, 12, 18, 0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1200,
                padding: "16px",
              }}
              onClick={() => setPreferencesRoomId(null)}
            >
              <div
                style={{
                  width: "min(520px, 94vw)",
                  background: "#fff",
                  border: "1px solid #cfcfcf",
                  borderRadius: "6px",
                  padding: "12px",
                  display: "grid",
                  gap: "10px",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Room Preferences</h3>
                <p style={{ margin: 0, fontSize: "0.82rem", color: "#555" }}>
                  Set whether this room should primarily be used by subjects that explicitly list it in Room Requirements.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", color: "#222" }}>
                  <input
                    type="checkbox"
                    checked={preferencesRoomPriorityOnly}
                    onChange={(e) => setPreferencesRoomPriorityOnly(e.target.checked)}
                  />
                  Prioritize this room for subjects that marked it as preferred (others use it only as last resort)
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                  <button type="button" className="secondary" onClick={() => setPreferencesRoomId(null)}>
                    Cancel
                  </button>
                  <button type="button" onClick={saveRoomPreferences}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}

          <h3 style={{ marginTop: "16px" }}>Base Room per Class</h3>
          <div className="room-base-by-trinn-grid">
            {classRowsByYear.map((row) => (
              <section key={row.yearPrefix} className="room-base-trinn-column">
                {row.classes.length === 0 ? (
                  <p className="room-base-empty">No classes found.</p>
                ) : (
                  <div className="room-base-class-list">
                    {row.classes.map((cls) => (
                      <div key={cls.id} className="room-base-class-row">
                        <label className="room-base-class-label">{cls.name}</label>
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
                          className={`room-base-select${cls.base_room_id ? "" : " room-base-select-unset"}`}
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
                )}
              </section>
            ))}
          </div>

          <h3 style={{ marginTop: "24px" }}>Idrettshaller</h3>
          <p style={{ margin: "0 0 10px", fontSize: "0.82rem", color: "#555" }}>
            Add sports halls here. In Preferences you can specify which subjects are allowed to use each hall — those subjects will <strong>only</strong> be scheduled in sports halls.
          </p>

          <section className="room-add-panel">
            <div className="room-add-controls">
              <input
                type="text"
                className="room-add-input"
                placeholder="Sports hall name(s) — separate multiple with commas"
                value={sportsHallForm.name}
                onChange={(e) => setSportsHallForm({ name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") upsertSportsHall(); }}
              />
              <button
                type="button"
                className="room-add-button"
                onClick={() => upsertSportsHall()}
              >
                {editingSportsHallId ? "Update Hall" : "Add Hall"}
              </button>
              {editingSportsHallId && (
                <button
                  type="button"
                  onClick={() => { setSportsHallForm({ name: "" }); setEditingSportsHallId(null); }}
                  className="secondary room-add-cancel"
                >
                  Cancel
                </button>
              )}
            </div>
            <div className="list room-list" style={{ maxHeight: "288px" }}>
              {sportsHalls.length === 0 ? (
                <p className="meeting-empty">No sports halls added yet.</p>
              ) : (
                sportsHalls.map((hall) => {
                  const allowedCount = hall.allowed_subject_ids.length;
                  return (
                    <div key={hall.id} className="room-list-item">
                      <span>
                        {hall.name}
                        {allowedCount > 0 && (
                          <span className="sh-subject-badge">{allowedCount} subject{allowedCount !== 1 ? "s" : ""}</span>
                        )}
                      </span>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => openSportsHallPreferences(hall.id)}
                          style={{
                            padding: "4px 8px",
                            fontSize: "0.72em",
                            background: allowedCount > 0 ? "#2f7f4f" : undefined,
                            borderColor: allowedCount > 0 ? "#2f7f4f" : undefined,
                            color: allowedCount > 0 ? "#fff" : undefined,
                          }}
                        >
                          Preferences
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => loadSportsHallIntoForm(hall)}
                          style={{ padding: "4px 8px", fontSize: "0.72em" }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => deleteSportsHall(hall.id)}
                          style={{ padding: "4px 8px", fontSize: "0.72em", color: "#c53" }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {sportsHallPreferencesId && (() => {
            const hall = sportsHalls.find((sh) => sh.id === sportsHallPreferencesId);
            if (!hall) return null;
            const query = sportsHallSubjectSearch.toLowerCase();
            const filteredSubjects = subjects.filter((s) =>
              !query || s.name.toLowerCase().includes(query)
            );
            // Group filtered subjects by name
            const nameGroupsMap: Record<string, string[]> = {};
            for (const s of filteredSubjects) {
              if (!nameGroupsMap[s.name]) nameGroupsMap[s.name] = [];
              nameGroupsMap[s.name].push(s.id);
            }
            const sortedGroupNames = Object.keys(nameGroupsMap).sort((a, b) => a.localeCompare(b, "nb"));
            return (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(10, 12, 18, 0.35)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 1200,
                  padding: "16px",
                }}
                onClick={() => setSportsHallPreferencesId(null)}
              >
                <div
                  style={{
                    width: "min(520px, 94vw)",
                    maxHeight: "80vh",
                    background: "#fff",
                    border: "1px solid #cfcfcf",
                    borderRadius: "6px",
                    padding: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 style={{ margin: 0, fontSize: "0.95rem" }}>Idrettshall Preferences — {hall.name}</h3>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#555" }}>
                    Select which subjects are allowed to use this sports hall. Selected subjects will <strong>only</strong> be scheduled in sports halls.
                  </p>
                  <input
                    type="text"
                    placeholder="Search subjects…"
                    value={sportsHallSubjectSearch}
                    onChange={(e) => setSportsHallSubjectSearch(e.target.value)}
                    style={{ padding: "6px 8px", fontSize: "0.85rem", border: "1px solid #ccc", borderRadius: "4px" }}
                  />
                  <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: "1px" }}>
                    {sortedGroupNames.length === 0 ? (
                      <p style={{ fontSize: "0.82rem", color: "#888", margin: 0 }}>No subjects found.</p>
                    ) : (
                      sortedGroupNames.map((groupName) => {
                        const groupIds = nameGroupsMap[groupName];
                        const allChecked = groupIds.every((id) => hall.allowed_subject_ids.includes(id));
                        const someChecked = groupIds.some((id) => hall.allowed_subject_ids.includes(id));
                        const firstSubj = subjects.find((s) => s.name === groupName);
                        return (
                          <label key={groupName} className="sh-subject-row">
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                              onChange={() => toggleSportsHallSubjectGroup(hall.id, groupIds, allChecked)}
                            />
                            <span className="sh-subject-name">{groupName}</span>
                            {groupIds.length > 1 && (
                              <span className="sh-group-count">{groupIds.length} klasser</span>
                            )}
                            {firstSubj?.subject_type === "programfag" && (
                              <span className="sh-subject-type-tag">programfag</span>
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                    <button type="button" onClick={() => setSportsHallPreferencesId(null)}>
                      Done
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

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
                          {t.workload_percent}% workload, {t.preferred_room_ids.length} room pref, {t.preferred_avoid_timeslots.length} pref, {t.unavailable_timeslots.length} blocked
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
                        {(() => {
                          const teacherPreferredRoomIds = Array.from(new Set((t.preferred_room_ids ?? []).filter((roomId) => rooms.some((room) => room.id === roomId))));
                          const teacherRoomDraft = teacherRoomSearchByTeacherId[t.id] ?? "";

                          return (
                            <div style={{ marginBottom: "8px" }}>
                              <label style={{ display: "block", fontSize: "0.85em", fontWeight: 600, marginBottom: "4px" }}>Room requirements</label>
                              <div className="room-requirements-top-row">
                                <div className="faggrupper-force-field" style={{ minWidth: 0 }}>
                                  <label className="faggrupper-force-label">Mode</label>
                                  <select
                                    value={t.room_requirement_mode ?? "always"}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      const nextMode = e.target.value === "once_per_week" ? "once_per_week" : "always";
                                      setTeachers((prev) => prev.map((teacher) => (
                                        teacher.id === t.id
                                          ? { ...teacher, room_requirement_mode: nextMode }
                                          : teacher
                                      )));
                                    }}
                                  >
                                    <option value="always">Always in selected rooms</option>
                                    <option value="once_per_week">At least once per week</option>
                                  </select>
                                </div>
                                <div className="faggrupper-teacher-add-row room-requirements-search-row">
                                  <input
                                    list={`teacher-room-options-${t.id}`}
                                    value={teacherRoomDraft}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      const nextValue = e.target.value;
                                      const resolvedRoomId = resolveRoomIdFromInput(nextValue);
                                      if (resolvedRoomId) {
                                        if (!teacherPreferredRoomIds.includes(resolvedRoomId)) {
                                          setTeachers((prev) => prev.map((teacher) => (
                                            teacher.id === t.id
                                              ? { ...teacher, preferred_room_ids: [...teacherPreferredRoomIds, resolvedRoomId] }
                                              : teacher
                                          )));
                                        }
                                        setTeacherRoomSearchByTeacherId((prev) => ({
                                          ...prev,
                                          [t.id]: "",
                                        }));
                                        return;
                                      }

                                      setTeacherRoomSearchByTeacherId((prev) => ({
                                        ...prev,
                                        [t.id]: nextValue,
                                      }));
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key !== "Enter") {
                                        return;
                                      }
                                      e.preventDefault();
                                      const resolvedRoomIds = resolveRoomIdsFromInput(teacherRoomDraft);
                                      if (resolvedRoomIds === null) {
                                        setStatusText("Could not resolve one or more room names. Use exact names from the list.");
                                        return;
                                      }
                                      if (resolvedRoomIds.length === 0) {
                                        return;
                                      }
                                      const nextSet = new Set(teacherPreferredRoomIds);
                                      for (const roomId of resolvedRoomIds) {
                                        nextSet.add(roomId);
                                      }
                                      setTeachers((prev) => prev.map((teacher) => (
                                        teacher.id === t.id
                                          ? { ...teacher, preferred_room_ids: Array.from(nextSet) }
                                          : teacher
                                      )));
                                      setTeacherRoomSearchByTeacherId((prev) => ({
                                        ...prev,
                                        [t.id]: "",
                                      }));
                                    }}
                                    placeholder="Search room(s), comma-separated"
                                  />
                                </div>
                              </div>
                              <div className="faggrupper-teacher-selected excluded-session-selected" style={{ marginTop: "0.35rem", maxHeight: "90px", overflowY: "auto", alignContent: "flex-start" }}>
                                {teacherPreferredRoomIds.length === 0 ? (
                                  <span className="faggrupper-teacher-empty">No preferred rooms selected</span>
                                ) : (
                                  teacherPreferredRoomIds.map((roomId) => {
                                    const roomLabel = roomNameById[roomId] ?? roomId;
                                    return (
                                      <span key={`${t.id}_${roomId}`} className="subject-class-chip subject-class-chip-editable faggrupper-teacher-chip excluded-session-chip">
                                        <span className="excluded-session-chip-label">{roomLabel}</span>
                                        <button
                                          type="button"
                                          className="subject-class-chip-remove"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setTeachers((prev) => prev.map((teacher) => (
                                              teacher.id === t.id
                                                ? {
                                                    ...teacher,
                                                    preferred_room_ids: teacherPreferredRoomIds.filter((id) => id !== roomId),
                                                  }
                                                : teacher
                                            )));
                                          }}
                                          aria-label={`Remove preferred room ${roomLabel}`}
                                        >
                                          x
                                        </button>
                                      </span>
                                    );
                                  })
                                )}
                              </div>
                              <datalist id={`teacher-room-options-${t.id}`}>
                                {filterRoomsForQuery(teacherRoomDraft).map((room) => (
                                  <option key={room.id} value={room.name} />
                                ))}
                              </datalist>
                            </div>
                          );
                        })()}

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
          {placementWarningDetails.length > 0 && (
            <details className="status-warning-panel">
              <summary>
                <span>{placementWarningSummary || "Some preferred units were not placed."}</span>
                <span className="status-warning-summary-hint">Click to expand</span>
              </summary>
              <div className="status-warning-content">
                <p>Details for subjects placed below preferred weekly units:</p>
                <ul>
                  {placementWarningDetails.map((detail) => (
                    <li key={`${detail.subject_id}_${detail.week}`}>
                      {detail.week}-week: {detail.subject_name} ({detail.subject_id}) required {detail.required_units}u, placed {detail.placed_units}u, missing {detail.missing_units}u.
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
          {unplacedStatusDetails.length > 0 && (
            <details className="status-unplaced-panel" open>
              <summary>
                <span>{unplacedStatusSummary || "Some subjects are not fully placed."}</span>
                <span className="status-warning-summary-hint">Click to collapse</span>
              </summary>
              <div className="status-warning-content">
                <p>Unplaced details by subject:</p>
                <ul>
                  {unplacedStatusDetails.map((detail) => (
                    <li key={detail.subject_id}>
                      {detail.subject_name} ({detail.subject_id}) | Teacher: {detail.teacher_label} | Required {detail.required_units}u, placed {detail.placed_units}u, missing {detail.missing_units}u. Reason: {detail.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
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
          {selectedTeacherCompareIds.length > 0 && (
            <div className="teacher-filter-summary" role="status" aria-live="polite">
              <div className="teacher-filter-summary-title">Selected teacher subjects (Blokk/Class - Subject)</div>
              <div className="teacher-filter-summary-grid">
                {teacherFilterSubjectSummaryRows.map((row) => (
                  <div key={row.teacherId} className="teacher-filter-summary-row">
                    <div className="teacher-filter-summary-teacher">{row.teacherName}</div>
                    <div className="teacher-filter-summary-items">
                      {row.entries.length === 0
                        ? "No subjects in generated schedule."
                        : row.entries.map((entry, idx) => (
                          <Fragment key={`${row.teacherId}_${entry.kind}_${entry.label}_${entry.subject}_${idx}`}>
                            <span
                              className={`teacher-filter-summary-item${idx % 2 === 0 ? " alt-emphasis" : ""}${hoveredTimelineSubjectId === entry.subjectId ? " subject-hover-linked" : ""}`}
                              onMouseEnter={() => setHoveredTimelineSubjectId(entry.subjectId)}
                              onMouseLeave={() => setHoveredTimelineSubjectId((current) => (current === entry.subjectId ? null : current))}
                            >
                              <span className="teacher-filter-summary-item-index">{idx + 1}</span>
                              {entry.kind}: {entry.label} - {entry.subject}
                            </span>
                          </Fragment>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
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
                {timelineMarks.map((minutes, index) => {
                  const topPct = ((minutes - DAY_START_MINUTES) / TIMELINE_TOTAL_MINUTES) * 100;
                  const isFirst = index === 0;
                  const isLast = index === timelineMarks.length - 1;
                  const translateY = isFirst ? "0%" : (isLast ? "-100%" : "-50%");
                  return (
                    <span key={minutes} style={{ top: `${topPct}%`, transform: `translateY(${translateY})` }}>
                      {minutesToTime(minutes)}
                    </span>
                  );
                })}
              </aside>

              <div className={`weekly-grid${hoveredTimelineSubjectId ? " subject-hover-active" : ""}`} style={{ gridTemplateColumns: `repeat(${calendarDays.length}, minmax(140px, 1fr))` }}>
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
                        blockSummaryGroupKey?: string;
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

                            const blockInfo = subjectToBlockInfo.get(item.subject_id);
                            const weekSplitKey = [
                              item.subject_id,
                              item.teacher_id,
                              item.timeslot_id,
                              item.day,
                              String(item.period),
                              [...(item.class_ids ?? [])].sort().join(","),
                            ].join("|");
                            const shouldUseSolvedWeekType = timelineWeekSplitByRoomKeys.has(weekSplitKey);
                            const effectiveWeekType = blockInfo
                              ? (shouldUseSolvedWeekType
                                ? item.week_type
                                : blockWeekTypeBySlot.get(`${blockInfo.block_id}|${item.timeslot_id}`))
                              : item.week_type;

                            return !effectiveWeekType || effectiveWeekType === weekView;
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
                            const roomLabel = item.room_id ? (roomNameById[item.room_id] ?? item.room_id) : undefined;
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
                                  ...teacherIds
                                    .filter((teacherId) => selectedTeacherCompareIds.includes(teacherId))
                                    .map((teacherId) => `teacher:${teacherId}`),
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
                              const isTeacherView = entityId.startsWith("teacher:");
                              const isRoomView = entityId.startsWith("room:");
                              if (isClassView && blockInfo) {
                                displayTitle = blockInfo.block_name;
                              } else if ((isTeacherView || isRoomView) && blockInfo) {
                                displayTitle = `${item.subject_name} (${blockInfo.block_name})`;
                              }

                              const blockSummaryGroupKey = isClassView && blockInfo
                                // In class view, show a single block-subject card per week.
                                ? `${entityId}|${item.subject_id}`
                                : undefined;

                              let blockWeekTypeFromDefinition: "A" | "B" | undefined = undefined;
                              if (blockInfo) {
                                const weekKey = `${blockInfo.block_id}|${item.timeslot_id}`;
                                const weekSplitKey = [
                                  item.subject_id,
                                  item.teacher_id,
                                  item.timeslot_id,
                                  item.day,
                                  String(item.period),
                                  [...(item.class_ids ?? [])].sort().join(","),
                                ].join("|");
                                const shouldUseSolvedWeekType = timelineWeekSplitByRoomKeys.has(weekSplitKey);
                                blockWeekTypeFromDefinition = blockWeekTypeBySlot.has(weekKey)
                                  ? (shouldUseSolvedWeekType ? item.week_type : blockWeekTypeBySlot.get(weekKey))
                                  : item.week_type;
                              }

                              const blockSummaryWeekKey = blockWeekTypeFromDefinition ?? "both";
                              const blockSummaryKey = blockSummaryGroupKey
                                ? `${blockSummaryGroupKey}|${blockSummaryWeekKey}`
                                : undefined;

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
                                blockSummaryGroupKey,
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
                        const groupsWithSpecificWeeks = new Set<string>();

                        for (const event of subjectEventsRaw) {
                          if (!event.blockSummaryGroupKey) {
                            continue;
                          }
                          if (event.weekType === "A" || event.weekType === "B") {
                            groupsWithSpecificWeeks.add(event.blockSummaryGroupKey);
                          }
                        }

                        for (const event of subjectEventsRaw) {
                          if (!event.blockSummaryKey) {
                            merged.push(event);
                            continue;
                          }

                          // If a block slot has explicit A/B entries, suppress the
                          // legacy shared variant for the same class/block/timeslot.
                          if (
                            event.blockSummaryGroupKey
                            && !event.weekType
                            && groupsWithSpecificWeeks.has(event.blockSummaryGroupKey)
                          ) {
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

                        const eventClassName = `weekly-event${event.kind === "meeting" ? " meeting" : ""}${event.isBlockSubject ? " block-subject" : ""}${event.kind === "subject" && event.weekType === "A" ? " alternating-a" : ""}${event.kind === "subject" && event.weekType === "B" ? " alternating-b" : ""}${isHovered ? " hovered" : ""}${isSubjectGroupHovered ? " subject-group-hovered" : ""}`;

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
                      No teacher matches &quot;{teacherOnSiteSearchQuery}&quot;.
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

      {activeTab === "overview" && (
      <section
        className="card overview-board"
        onMouseLeave={() => {
          setOverviewHoverCard(null);
          setOverviewHoverSubjectKey(null);
        }}
      >
        <div className="overview-header-row">
          <h2>Oversikt</h2>
          <div className="overview-controls-row">
            <div className="overview-subtabs" role="tablist" aria-label="Oversikt type">
              <button
                type="button"
                className={`secondary overview-subtab-button ${activeOverviewSubtab === "rooms" ? "active" : ""}`}
                onClick={() => setActiveOverviewSubtab("rooms")}
              >
                Rom
              </button>
              <button
                type="button"
                className={`secondary overview-subtab-button ${activeOverviewSubtab === "teachers" ? "active" : ""}`}
                onClick={() => setActiveOverviewSubtab("teachers")}
              >
                Lærere
              </button>
              <button
                type="button"
                className={`secondary overview-subtab-button ${activeOverviewSubtab === "classes" ? "active" : ""}`}
                onClick={() => setActiveOverviewSubtab("classes")}
              >
                Klasser
              </button>
              <button
                type="button"
                className={`secondary overview-subtab-button ${activeOverviewSubtab === "constraints" ? "active" : ""}`}
                onClick={() => setActiveOverviewSubtab("constraints")}
              >
                Begrensninger
              </button>
            </div>
            {activeOverviewSubtab !== "constraints" && (
              <div className="compare-week-view" style={{ minWidth: "170px" }}>
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
            )}
          </div>
        </div>

        {activeOverviewSubtab === "constraints" ? (
          <div className="overview-constraints-wrap">
            <p>
              Rediger lærer- og fagbegrensninger her: romkrav (alltid eller minst en gang per uke) og lærere som ikke kan undervise i bestemte tider.
            </p>

            <section className="overview-constraints-section">
              <h3>Lærere: Romkrav</h3>
              {teachersWithCustomRoomConstraints.length === 0 ? (
                <p style={{ color: "#999", marginTop: "8px" }}>Ingen avvik fra standard (always + ingen rom) for lærere.</p>
              ) : (
                <div className="overview-constraints-table-wrap">
                  <table className="overview-constraints-table">
                    <thead>
                      <tr>
                        <th>Lærer</th>
                        <th>Rom-modus</th>
                        <th>Foretrukne rom</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teachersWithCustomRoomConstraints.map((teacher) => {
                        const teacherPreferredRoomIds = Array.from(new Set((teacher.preferred_room_ids ?? []).filter((roomId) => rooms.some((room) => room.id === roomId))));
                        const roomDraft = teacherRoomSearchByTeacherId[teacher.id] ?? "";

                        return (
                          <tr key={`constraint_teacher_rooms_${teacher.id}`}>
                            <td>{teacher.name}</td>
                            <td>
                              <select
                                value={teacher.room_requirement_mode ?? "always"}
                                onChange={(e) => {
                                  const nextMode = e.target.value === "once_per_week" ? "once_per_week" : "always";
                                  setTeachers((prev) => prev.map((entry) => (
                                    entry.id === teacher.id
                                      ? { ...entry, room_requirement_mode: nextMode }
                                      : entry
                                  )));
                                }}
                              >
                                <option value="always">Always</option>
                                <option value="once_per_week">Once per week</option>
                              </select>
                            </td>
                            <td>
                              <div className="overview-constraints-field-stack">
                                <input
                                  list={`overview-teacher-room-options-${teacher.id}`}
                                  value={roomDraft}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    const resolvedRoomId = resolveRoomIdFromInput(nextValue);
                                    if (resolvedRoomId) {
                                      if (!teacherPreferredRoomIds.includes(resolvedRoomId)) {
                                        setTeachers((prev) => prev.map((entry) => (
                                          entry.id === teacher.id
                                            ? { ...entry, preferred_room_ids: [...teacherPreferredRoomIds, resolvedRoomId] }
                                            : entry
                                        )));
                                      }
                                      setTeacherRoomSearchByTeacherId((prev) => ({ ...prev, [teacher.id]: "" }));
                                      return;
                                    }
                                    setTeacherRoomSearchByTeacherId((prev) => ({ ...prev, [teacher.id]: nextValue }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") {
                                      return;
                                    }
                                    e.preventDefault();
                                    const resolvedRoomIds = resolveRoomIdsFromInput(roomDraft);
                                    if (resolvedRoomIds === null) {
                                      setStatusText("Could not resolve one or more room names. Use exact names from the list.");
                                      return;
                                    }
                                    if (resolvedRoomIds.length === 0) {
                                      return;
                                    }
                                    const nextSet = new Set(teacherPreferredRoomIds);
                                    for (const roomId of resolvedRoomIds) {
                                      nextSet.add(roomId);
                                    }
                                    setTeachers((prev) => prev.map((entry) => (
                                      entry.id === teacher.id
                                        ? { ...entry, preferred_room_ids: Array.from(nextSet) }
                                        : entry
                                    )));
                                    setTeacherRoomSearchByTeacherId((prev) => ({ ...prev, [teacher.id]: "" }));
                                  }}
                                  placeholder="Søk rom (kommaseparert)"
                                />
                                <div className="overview-constraints-chip-row">
                                  {teacherPreferredRoomIds.length === 0 ? (
                                    <span className="overview-constraints-empty">Ingen rom valgt</span>
                                  ) : (
                                    teacherPreferredRoomIds.map((roomId) => {
                                      const roomLabel = roomNameById[roomId] ?? roomId;
                                      return (
                                        <span key={`teacher_room_${teacher.id}_${roomId}`} className="overview-constraints-chip">
                                          <span>{roomLabel}</span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setTeachers((prev) => prev.map((entry) => (
                                                entry.id === teacher.id
                                                  ? { ...entry, preferred_room_ids: teacherPreferredRoomIds.filter((id) => id !== roomId) }
                                                  : entry
                                              )));
                                            }}
                                            aria-label={`Fjern rom ${roomLabel}`}
                                          >
                                            x
                                          </button>
                                        </span>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                              <datalist id={`overview-teacher-room-options-${teacher.id}`}>
                                {filterRoomsForQuery(roomDraft).map((room) => (
                                  <option key={room.id} value={room.name} />
                                ))}
                              </datalist>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="overview-constraints-section">
              <h3>Lærere: Ikke tilgjengelige tider</h3>
              {teachersWithUnavailableTimes.length === 0 ? (
                <p style={{ color: "#999", marginTop: "8px" }}>Ingen avvik fra standard (ingen blokkerte tider) for lærere.</p>
              ) : (
                <div className="overview-constraints-table-wrap">
                  <table className="overview-constraints-table">
                    <thead>
                      <tr>
                        <th>Lærer</th>
                        <th>Ikke tilgjengelig</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teachersWithUnavailableTimes.map((teacher) => {
                        const unavailableDraft = overviewTeacherUnavailableDraftById[teacher.id] ?? "";
                        const unavailableSlots = teacher.unavailable_timeslots
                          .map((slotId) => timeslotById[slotId])
                          .filter((slot): slot is Timeslot => Boolean(slot))
                          .sort((a, b) => {
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

                        return (
                          <tr key={`constraint_teacher_times_${teacher.id}`}>
                            <td>{teacher.name}</td>
                            <td>
                              <div className="overview-constraints-field-stack">
                                <input
                                  list={`overview-teacher-timeslot-options-${teacher.id}`}
                                  value={unavailableDraft}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    const resolvedTimeslotId = resolveTimeslotIdFromInput(nextValue);
                                    if (resolvedTimeslotId) {
                                      if (!teacher.unavailable_timeslots.includes(resolvedTimeslotId)) {
                                        setTeachers((prev) => prev.map((entry) => (
                                          entry.id === teacher.id
                                            ? { ...entry, unavailable_timeslots: [...entry.unavailable_timeslots, resolvedTimeslotId] }
                                            : entry
                                        )));
                                      }
                                      setOverviewTeacherUnavailableDraftById((prev) => ({ ...prev, [teacher.id]: "" }));
                                      return;
                                    }
                                    setOverviewTeacherUnavailableDraftById((prev) => ({ ...prev, [teacher.id]: nextValue }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") {
                                      return;
                                    }
                                    e.preventDefault();
                                    const resolvedTimeslotIds = resolveTimeslotIdsFromInput(unavailableDraft);
                                    if (resolvedTimeslotIds === null) {
                                      setStatusText("Could not resolve one or more sessions. Use exact labels from the list.");
                                      return;
                                    }
                                    if (resolvedTimeslotIds.length === 0) {
                                      return;
                                    }
                                    const nextSet = new Set(teacher.unavailable_timeslots);
                                    for (const slotId of resolvedTimeslotIds) {
                                      nextSet.add(slotId);
                                    }
                                    setTeachers((prev) => prev.map((entry) => (
                                      entry.id === teacher.id
                                        ? { ...entry, unavailable_timeslots: Array.from(nextSet) }
                                        : entry
                                    )));
                                    setOverviewTeacherUnavailableDraftById((prev) => ({ ...prev, [teacher.id]: "" }));
                                  }}
                                  placeholder="Søk time(r), kommaseparert"
                                />
                                <div className="overview-constraints-chip-row">
                                  {unavailableSlots.length === 0 ? (
                                    <span className="overview-constraints-empty">Ingen blokkerte tider</span>
                                  ) : (
                                    unavailableSlots.map((slot) => {
                                      const slotLabel = formatTimeslotLabel(slot);
                                      return (
                                        <span key={`teacher_unavailable_${teacher.id}_${slot.id}`} className="overview-constraints-chip">
                                          <span>{slotLabel}</span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setTeachers((prev) => prev.map((entry) => (
                                                entry.id === teacher.id
                                                  ? {
                                                      ...entry,
                                                      unavailable_timeslots: entry.unavailable_timeslots.filter((id) => id !== slot.id),
                                                    }
                                                  : entry
                                              )));
                                            }}
                                            aria-label={`Fjern blokkert tid ${slotLabel}`}
                                          >
                                            x
                                          </button>
                                        </span>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                              <datalist id={`overview-teacher-timeslot-options-${teacher.id}`}>
                                {filterTimeslotsForQuery(unavailableDraft).map((slot) => (
                                  <option key={slot.id} value={formatTimeslotLabel(slot)} />
                                ))}
                              </datalist>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="overview-constraints-section">
              <h3>Fag: Romkrav</h3>
              {subjectsWithCustomRoomConstraints.length === 0 ? (
                <p style={{ color: "#999", marginTop: "8px" }}>Ingen avvik fra standard (always + ingen rom) for fag.</p>
              ) : (
                <div className="overview-constraints-table-wrap">
                  <table className="overview-constraints-table">
                    <thead>
                      <tr>
                        <th>Fag</th>
                        <th>Type</th>
                        <th>Rom-modus</th>
                        <th>Foretrukne rom</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subjectsWithCustomRoomConstraints.map((subject) => {
                        const preferredRoomIds = Array.from(new Set((subject.preferred_room_ids ?? []).filter((roomId) => rooms.some((room) => room.id === roomId))));
                        const roomSearchKey = `overview_subject_${subject.id}`;
                        const roomDraft = roomSearchBySubjectEntity[roomSearchKey] ?? "";

                        return (
                          <tr key={`constraint_subject_rooms_${subject.id}`}>
                            <td>{subject.name}</td>
                            <td>{subject.subject_type === "fellesfag" ? "Fellesfag" : "Programfag"}</td>
                            <td>
                              <select
                                value={subject.room_requirement_mode ?? "always"}
                                onChange={(e) => updateSubjectCard(subject.id, {
                                  room_requirement_mode: e.target.value === "once_per_week" ? "once_per_week" : "always",
                                })}
                              >
                                <option value="always">Always</option>
                                <option value="once_per_week">Once per week</option>
                              </select>
                            </td>
                            <td>
                              <div className="overview-constraints-field-stack">
                                <input
                                  list={`overview-subject-room-options-${subject.id}`}
                                  value={roomDraft}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    const resolvedRoomId = resolveRoomIdFromInput(nextValue);
                                    if (resolvedRoomId) {
                                      if (!preferredRoomIds.includes(resolvedRoomId)) {
                                        updateSubjectCard(subject.id, {
                                          preferred_room_ids: [...preferredRoomIds, resolvedRoomId],
                                        });
                                      }
                                      setRoomSearchBySubjectEntity((prev) => ({ ...prev, [roomSearchKey]: "" }));
                                      return;
                                    }
                                    setRoomSearchBySubjectEntity((prev) => ({ ...prev, [roomSearchKey]: nextValue }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key !== "Enter") {
                                      return;
                                    }
                                    e.preventDefault();
                                    const resolvedRoomIds = resolveRoomIdsFromInput(roomDraft);
                                    if (resolvedRoomIds === null) {
                                      setStatusText("Could not resolve one or more room names. Use exact names from the list.");
                                      return;
                                    }
                                    if (resolvedRoomIds.length === 0) {
                                      return;
                                    }
                                    const nextSet = new Set(preferredRoomIds);
                                    for (const roomId of resolvedRoomIds) {
                                      nextSet.add(roomId);
                                    }
                                    updateSubjectCard(subject.id, {
                                      preferred_room_ids: Array.from(nextSet),
                                    });
                                    setRoomSearchBySubjectEntity((prev) => ({ ...prev, [roomSearchKey]: "" }));
                                  }}
                                  placeholder="Søk rom (kommaseparert)"
                                />
                                <div className="overview-constraints-chip-row">
                                  {preferredRoomIds.length === 0 ? (
                                    <span className="overview-constraints-empty">Ingen rom valgt</span>
                                  ) : (
                                    preferredRoomIds.map((roomId) => {
                                      const roomLabel = roomNameById[roomId] ?? roomId;
                                      return (
                                        <span key={`subject_room_${subject.id}_${roomId}`} className="overview-constraints-chip">
                                          <span>{roomLabel}</span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              updateSubjectCard(subject.id, {
                                                preferred_room_ids: preferredRoomIds.filter((id) => id !== roomId),
                                              });
                                            }}
                                            aria-label={`Fjern rom ${roomLabel}`}
                                          >
                                            x
                                          </button>
                                        </span>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                              <datalist id={`overview-subject-room-options-${subject.id}`}>
                                {filterRoomsForQuery(roomDraft).map((room) => (
                                  <option key={room.id} value={room.name} />
                                ))}
                              </datalist>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : (
          <>
            <p>
              {overviewEntityLabel} on rows, week sessions on columns. Each cell shows the scheduled subject in that slot.
            </p>

            <div className="overview-filter-bar">
              <div className="overview-filter-input-wrap overview-filter-columns-wrap">
                <label className="overview-filter-field">
                  <span>Klasse</span>
                  <input
                    list="overview-class-filter-options"
                    type="text"
                    value={overviewClassFilterQuery}
                    onChange={(e) => setOverviewClassFilterQuery(e.target.value)}
                    placeholder="f.eks. 1STA, 2STB"
                    className="overview-filter-input"
                  />
                </label>
                <label className="overview-filter-field">
                  <span>Lærer</span>
                  <input
                    list="overview-teacher-filter-options"
                    type="text"
                    value={overviewTeacherFilterQuery}
                    onChange={(e) => setOverviewTeacherFilterQuery(e.target.value)}
                    placeholder="f.eks. Ola Nordmann"
                    className="overview-filter-input"
                  />
                </label>
                <label className="overview-filter-field">
                  <span>Rom</span>
                  <input
                    list="overview-room-filter-options"
                    type="text"
                    value={overviewRoomFilterQuery}
                    onChange={(e) => setOverviewRoomFilterQuery(e.target.value)}
                    placeholder="f.eks. R202, Idrettshall"
                    className="overview-filter-input"
                  />
                </label>
                <div className="overview-filter-actions-inline">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setOverviewClassFilterQuery("");
                      setOverviewTeacherFilterQuery("");
                      setOverviewRoomFilterQuery("");
                      setOverviewSelectedRowIds([]);
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <datalist id="overview-class-filter-options">
                {overviewAutocompleteOptionsByKind.classes.map((option) => (
                  <option key={`overview_filter_class_option_${option}`} value={option} />
                ))}
              </datalist>
              <datalist id="overview-teacher-filter-options">
                {overviewAutocompleteOptionsByKind.teachers.map((option) => (
                  <option key={`overview_filter_teacher_option_${option}`} value={option} />
                ))}
              </datalist>
              <datalist id="overview-room-filter-options">
                {overviewAutocompleteOptionsByKind.rooms.map((option) => (
                  <option key={`overview_filter_room_option_${option}`} value={option} />
                ))}
              </datalist>
            </div>

            <div className={`overview-hover-status-line ${overviewHoverSubjectStatus ? "" : "is-empty"}`}>
              <strong>{overviewHoverSubjectStatus?.subjectTitle ?? "Hover a session"}</strong>
              <span>{overviewHoverSubjectStatus?.text ?? "Matched positions will be shown here without shifting the table."}</span>
            </div>

            {schedule.length === 0 ? (
              <p style={{ color: "#999", marginTop: "10px" }}>Generate a schedule to populate this overview.</p>
            ) : overviewFlatColumns.length === 0 ? (
              <p style={{ color: "#999", marginTop: "10px" }}>No timeslots found in the active week calendar.</p>
            ) : displayedOverviewRows.length === 0 ? (
              <p style={{ color: "#999", marginTop: "10px" }}>No {overviewEntityLabel.toLowerCase()} available.</p>
            ) : (
              <div className="overview-table-wrap">
                <table className="overview-table">
                  <thead>
                    <tr>
                      <th rowSpan={2} className="overview-entity-head">{overviewEntityLabel}</th>
                      {overviewColumnsByDay
                        .filter((group) => group.slots.length > 0)
                        .map((group) => {
                          const dayIndex = overviewColumnsByDay.findIndex((candidate) => candidate.day === group.day);
                          const toneClass = dayIndex % 2 === 0 ? "overview-day-even" : "overview-day-odd";
                          return (
                          <th key={`day_${group.day}`} colSpan={group.slots.length} className={`overview-day-head ${toneClass}`}>
                            {group.day}
                          </th>
                          );
                        })}
                    </tr>
                    <tr>
                      {overviewFlatColumns.map((column) => (
                        <th
                          key={`slot_${column.day}_${column.slot.id}`}
                          className={`overview-slot-head ${column.dayIndex % 2 === 0 ? "overview-day-even" : "overview-day-odd"} ${overviewHoverSubjectKey && overviewHoverSubjectSlotIds.has(column.slot.id) ? "overview-slot-head-hover-match" : ""}`}
                        >
                          <div>{column.slot.start_time ?? `P${column.slot.period}`}</div>
                          <small>{column.slot.end_time ?? ""}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedOverviewRows.map((row) => (
                      <tr key={`${row.kind}_${row.id}`}>
                        <th className="overview-row-label">
                          {row.supplemental
                            ? `${row.kind === "teachers" ? "Lærer" : row.kind === "classes" ? "Klasse" : "Rom"}: ${row.label}`
                            : row.label}
                        </th>
                        {overviewFlatColumns.map((column) => {
                          const rawEntries = overviewCellMapsByKind[row.kind].get(`${row.id}|${column.slot.id}`) ?? [];
                          const entriesBySignature = new Map<string, {
                            key: string;
                            title: string;
                            subtitle: string;
                            teacher_label?: string;
                            match_signature?: string;
                            hover_subject_key?: string;
                            isMeeting?: boolean;
                            weeks: Set<"A" | "B">;
                            hasSharedWeek: boolean;
                          }>();

                          for (const entry of rawEntries) {
                            const signature = `${entry.title}|${entry.subtitle}|${entry.teacher_label ?? ""}|${entry.match_signature ?? ""}|${entry.hover_subject_key ?? ""}|${entry.isMeeting ? "1" : "0"}`;
                            const current = entriesBySignature.get(signature) ?? {
                              key: entry.key,
                              title: entry.title,
                              subtitle: entry.subtitle,
                              teacher_label: entry.teacher_label,
                              match_signature: entry.match_signature,
                              hover_subject_key: entry.hover_subject_key,
                              isMeeting: entry.isMeeting,
                              weeks: new Set<"A" | "B">(),
                              hasSharedWeek: false,
                            };

                            if (entry.week_type === "A" || entry.week_type === "B") {
                              current.weeks.add(entry.week_type);
                            } else {
                              current.hasSharedWeek = true;
                            }

                            entriesBySignature.set(signature, current);
                          }

                          const entries = Array.from(entriesBySignature.values()).map((entry) => {
                            const weekType = entry.hasSharedWeek || (entry.weeks.has("A") && entry.weeks.has("B"))
                              ? undefined
                              : entry.weeks.has("A")
                                ? "A"
                                : entry.weeks.has("B")
                                  ? "B"
                                  : undefined;

                            return {
                              key: entry.key,
                              title: entry.title,
                              subtitle: entry.subtitle,
                              teacher_label: entry.teacher_label,
                              match_signature: entry.match_signature,
                              hover_subject_key: entry.hover_subject_key,
                              isMeeting: entry.isMeeting,
                              week_type: weekType,
                            };
                          });

                          return (
                            <td
                              key={`${row.kind}_${row.id}_${column.slot.id}`}
                              className={`overview-cell ${column.dayIndex % 2 === 0 ? "overview-day-even" : "overview-day-odd"}`}
                            >
                              {entries.length === 0 ? (
                                <span className="overview-empty-cell">-</span>
                              ) : (
                                <div className="overview-cell-entries">
                                  {entries.map((entry) => (
                                    <div
                                      key={entry.key}
                                      data-hover-subject-key={entry.hover_subject_key ?? ""}
                                      className={`overview-entry ${entry.isMeeting ? "meeting" : entry.week_type === "A" ? "week-a" : entry.week_type === "B" ? "week-b" : "week-shared"} ${overviewHasActiveFiltering && !entry.isMeeting && entry.match_signature && overviewMatchedSubjectBySlot.has(`${column.slot.id}|${entry.match_signature}`) ? "overview-entry-match" : ""} ${overviewHoverSubjectKey && entry.hover_subject_key === overviewHoverSubjectKey ? "overview-entry-hover-related" : ""}`}
                                      onMouseEnter={(e) => {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const cardWidth = 280;
                                        const cardHeight = 170;
                                        const gap = 10;
                                        const viewportWidth = window.innerWidth;
                                        const viewportHeight = window.innerHeight;

                                        const clampX = (xPos: number) => Math.min(
                                          Math.max(gap, xPos),
                                          Math.max(gap, viewportWidth - cardWidth - gap)
                                        );
                                        const clampY = (yPos: number) => Math.min(
                                          Math.max(gap, yPos),
                                          Math.max(gap, viewportHeight - cardHeight - gap)
                                        );

                                        const candidatePositions = [
                                          { x: clampX(rect.right + gap), y: clampY(rect.top) },
                                          { x: clampX(rect.left - cardWidth - gap), y: clampY(rect.top) },
                                          { x: clampX(rect.left), y: clampY(rect.bottom + gap) },
                                          { x: clampX(rect.left), y: clampY(rect.top - cardHeight - gap) },
                                        ];

                                        const targetHoverKey = entry.hover_subject_key ?? "";
                                        const relatedRects: DOMRect[] = [];
                                        if (targetHoverKey) {
                                          const relatedElements = Array.from(
                                            document.querySelectorAll<HTMLElement>(".overview-entry[data-hover-subject-key]")
                                          );
                                          for (const el of relatedElements) {
                                            if (el === e.currentTarget) {
                                              continue;
                                            }
                                            if ((el.dataset.hoverSubjectKey ?? "") !== targetHoverKey) {
                                              continue;
                                            }
                                            relatedRects.push(el.getBoundingClientRect());
                                          }
                                        }

                                        const overlapArea = (
                                          a: { left: number; right: number; top: number; bottom: number },
                                          b: DOMRect,
                                        ) => {
                                          const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
                                          const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
                                          return overlapWidth * overlapHeight;
                                        };

                                        let bestPos = candidatePositions[0];
                                        let bestOverlap = Number.POSITIVE_INFINITY;

                                        for (const pos of candidatePositions) {
                                          const cardRect = {
                                            left: pos.x,
                                            right: pos.x + cardWidth,
                                            top: pos.y,
                                            bottom: pos.y + cardHeight,
                                          };
                                          let totalOverlap = 0;
                                          for (const relRect of relatedRects) {
                                            totalOverlap += overlapArea(cardRect, relRect);
                                          }
                                          if (totalOverlap < bestOverlap) {
                                            bestOverlap = totalOverlap;
                                            bestPos = pos;
                                          }
                                        }

                                        const timeRange = `${column.slot.start_time ?? `P${column.slot.period}`}${column.slot.end_time ? `-${column.slot.end_time}` : ""}`;

                                        setOverviewHoverCard({
                                          x: bestPos.x,
                                          y: bestPos.y,
                                          title: entry.title,
                                          lines: [
                                            `${row.kind === "teachers" ? "Lærer" : row.kind === "classes" ? "Klasse" : "Rom"}: ${row.label}`,
                                            `Tid: ${column.day} ${timeRange}`,
                                            ...(entry.week_type ? [`Uke: ${entry.week_type}`] : []),
                                            ...(entry.teacher_label ? [`Lærer: ${entry.teacher_label}`] : []),
                                            ...(entry.subtitle ? [entry.subtitle] : []),
                                          ],
                                        });
                                        setOverviewHoverSubjectKey(entry.hover_subject_key ?? null);
                                      }}
                                      onMouseLeave={() => {
                                        setOverviewHoverCard(null);
                                        setOverviewHoverSubjectKey(null);
                                      }}
                                    >
                                      <div className="overview-entry-title-row">
                                        <strong>{entry.title}</strong>
                                        {entry.week_type ? <small>{entry.week_type}</small> : null}
                                      </div>
                                      {entry.subtitle ? <span>{entry.subtitle}</span> : null}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {overviewHoverCard && (
          <div
            className="overview-hover-card"
            style={{ left: `${overviewHoverCard.x}px`, top: `${overviewHoverCard.y}px` }}
          >
            <strong>{overviewHoverCard.title}</strong>
            {overviewHoverCard.lines.map((line, idx) => (
              <div key={`hover_line_${idx}`}>{line}</div>
            ))}
          </div>
        )}
      </section>
      )}
    </main>
  );
}
