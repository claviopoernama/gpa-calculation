// app.js

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ======================================================================
   Grading scale & validation
   ====================================================================== */

const GRADE_SCALE = [
  { min: 91, max: 100, letter: "A", index: 4.0 },
  { min: 86, max: 90, letter: "A-", index: 3.7 },
  { min: 81, max: 85, letter: "B+", index: 3.3 },
  { min: 76, max: 80, letter: "B", index: 3.0 },
  { min: 71, max: 75, letter: "B-", index: 2.7 },
  { min: 66, max: 70, letter: "C+", index: 2.3 },
  { min: 60, max: 65, letter: "C", index: 2.0 },
  { min: 0, max: 59, letter: "F", index: 0.0 },
];

const LETTER_INDEX_MAP = GRADE_SCALE.reduce((map, entry) => {
  map[entry.letter] = entry.index;
  return map;
}, {});

const VALID_LETTERS = GRADE_SCALE.map((entry) => entry.letter);

const GRADE_COLORS = {
  A: "#A6802D",
  "A-": "#C9A85C",
  "B+": "#3F6B4F",
  B: "#5C8A6E",
  "B-": "#8FB39C",
  "C+": "#B8873A",
  C: "#D2A868",
  F: "#9C3B3B",
};

function numberToGrade(score) {
  const match = GRADE_SCALE.find((entry) => score >= entry.min && score <= entry.max);
  return match ? { letter: match.letter, index: match.index } : null;
}

function letterForRequiredIndex(requiredIndex) {
  if (requiredIndex > 4.0) return null;
  if (requiredIndex <= 0) return GRADE_SCALE[GRADE_SCALE.length - 1];
  const sorted = [...GRADE_SCALE].sort((a, b) => a.index - b.index);
  return sorted.find((entry) => entry.index >= requiredIndex) || sorted[sorted.length - 1];
}

function parseGradeInput(raw) {
  const value = (raw || "").trim();

  if (!value) {
    return { ok: false, message: "Enter a score (0-100) or a letter grade." };
  }

  if (/^\d+(\.\d+)?$/.test(value)) {
    const num = parseFloat(value);
    if (num < 0 || num > 100) {
      return { ok: false, message: "Score must be between 0 and 100." };
    }
    const grade = numberToGrade(num);
    return { ok: true, number: num, letter: grade.letter, index: grade.index };
  }

  const normalized = value.toUpperCase().replace(/\s+/g, "");
  if (Object.prototype.hasOwnProperty.call(LETTER_INDEX_MAP, normalized)) {
    return { ok: true, number: null, letter: normalized, index: LETTER_INDEX_MAP[normalized] };
  }

  return {
    ok: false,
    message: `Enter a number 0-100 or a valid letter grade (${VALID_LETTERS.join(", ")}).`,
  };
}

function validateSubjectName(raw) {
  const value = (raw || "").trim();
  if (!value) return { ok: false, message: "Subject name is required." };
  if (value.length > 100) return { ok: false, message: "Subject name is too long." };
  return { ok: true, value };
}

function validateCredits(raw) {
  const value = (raw || "").trim();
  if (!value) return { ok: false, message: "Credits (SKS) is required." };
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, message: "Credits must be a positive number." };
  }
  if (num > 24) {
    return { ok: false, message: "That doesn't look like a valid credit value." };
  }
  return { ok: true, value: num };
}

/* ======================================================================
   Semester / Period block logic
   ====================================================================== */

function semesterMode(semester) {
  if (!Number.isInteger(semester) || semester < 1) return "invalid";
  if (semester === 3 || semester === 6) return "compact";
  if (semester <= 6) return "split";
  return "flexible";
}

function validateSemesterPeriod(rawSemester, wantsSplit, periodValue) {
  const semester = Number(rawSemester);
  if (!Number.isInteger(semester) || semester < 1) {
    return { ok: false, message: "Enter a valid semester number (1 or higher)." };
  }
  if (wantsSplit) {
    if (periodValue !== "A" && periodValue !== "B") {
      return { ok: false, message: "Choose Period A or Period B." };
    }
    return { ok: true, semester, period: periodValue };
  }
  return { ok: true, semester, period: null };
}

function resolveSemesterPeriodForImport(rawSemester, rawPeriod) {
  const semester = Number(rawSemester);
  if (!Number.isInteger(semester) || semester < 1) {
    return { ok: false, message: "Semester must be a positive whole number." };
  }
  const mode = semesterMode(semester);
  const periodInput = (rawPeriod || "").trim().toUpperCase();

  if (mode === "compact") {
    return { ok: true, semester, period: null };
  }
  if (mode === "split") {
    if (periodInput !== "A" && periodInput !== "B") {
      return { ok: false, message: `Semester ${semester} requires Period A or B.` };
    }
    return { ok: true, semester, period: periodInput };
  }
  if (periodInput === "A" || periodInput === "B") {
    return { ok: true, semester, period: periodInput };
  }
  return { ok: true, semester, period: null };
}

function blockKeyOf(course) {
  return `S${course.semester || 0}${course.period || ""}`;
}

function blockLabelOf({ semester, period }) {
  return period ? `Semester ${semester} · Period ${period}` : `Semester ${semester} (Compact)`;
}

/* ======================================================================
   State
   ====================================================================== */

let currentUser = null;
let unsubscribeCourses = null;
let courses = [];

let searchTerm = "";
let sortState = { key: "createdAt", dir: "asc" };
let filters = { grade: "all", credits: "all", type: "all" };

let includePlanned = true;
let remainingSksManuallySet = false;

let editingCourseId = null;
let deletingCourse = null;
let drawerCourseId = null;

let csvParsedRows = [];
const collapsedSemesters = new Set();

let trendChartInstance = null;
let distributionChartInstance = null;

// --- Chart readiness gating -------------------------------------------
// Charts must not be touched until BOTH of these are true: auth has
// resolved to a signed-in user, AND at least one Firestore snapshot for
// that user's courses has been received (even if it's empty). Without
// this gate, a stray render() call triggered mid-navigation (e.g. right
// after sign-in, before the first onSnapshot fires) can try to draw into
// a canvas with no data context and no guaranteed layout yet.
let authReady = false;
let dataLoaded = false;

/* ======================================================================
   DOM references
   ====================================================================== */

const el = {};

function cacheDom() {
  el.userEmail = document.getElementById("user-email");
  el.searchInput = document.getElementById("search-input");
  el.addCourseBtn = document.getElementById("add-course-btn");
  el.semesterGroups = document.getElementById("semester-groups");
  el.emptyState = document.getElementById("empty-state");
  el.noResultsState = document.getElementById("no-results-state");
  el.loadingState = document.getElementById("loading-state");

  el.metricTotalCourses = document.getElementById("metric-total-courses");
  el.metricTotalBreakdown = document.getElementById("metric-total-breakdown");
  el.metricSksTotal = document.getElementById("metric-sks-total");
  el.metricProductTotal = document.getElementById("metric-product-total");
  el.metricIpk = document.getElementById("metric-ipk");
  el.includePlannedToggle = document.getElementById("include-planned-toggle");

  el.simTargetIpk = document.getElementById("sim-target-ipk");
  el.simRemainingSks = document.getElementById("sim-remaining-sks");
  el.simResultText = document.getElementById("sim-result-text");

  el.filterGrade = document.getElementById("filter-grade");
  el.filterCredits = document.getElementById("filter-credits");
  el.filterType = document.getElementById("filter-type");
  el.filterResetBtn = document.getElementById("filter-reset-btn");

  el.csvImportBtn = document.getElementById("csv-import-btn");
  el.csvExportBtn = document.getElementById("csv-export-btn");
  el.csvFileInput = document.getElementById("csv-file-input");
  el.csvModal = document.getElementById("csv-modal");
  el.csvModalClose = document.getElementById("csv-modal-close");
  el.csvCancelBtn = document.getElementById("csv-cancel-btn");
  el.csvConfirmBtn = document.getElementById("csv-confirm-btn");
  el.csvFileName = document.getElementById("csv-file-name");
  el.csvPreview = document.getElementById("csv-preview");
  el.csvErrors = document.getElementById("csv-errors");

  el.courseModal = document.getElementById("course-modal");
  el.courseForm = document.getElementById("course-form");
  el.courseModalTitle = document.getElementById("course-modal-title");
  el.courseIdField = document.getElementById("course-id");
  el.isHypothetical = document.getElementById("is-hypothetical");
  el.courseSemesterNumber = document.getElementById("course-semester-number");
  el.coursePeriod = document.getElementById("course-period");
  el.periodSelectWrapper = document.getElementById("period-select-wrapper");
  el.periodFlexWrapper = document.getElementById("period-flex-wrapper");
  el.periodFlexToggle = document.getElementById("period-flex-toggle");
  el.periodCompactNote = document.getElementById("period-compact-note");
  el.courseSemesterError = document.getElementById("course-semester-error");
  el.subjectCodeInput = document.getElementById("subject-code");
  el.subjectNameInput = document.getElementById("subject-name");
  el.creditsInput = document.getElementById("credits-input");
  el.gradeInput = document.getElementById("grade-input");
  el.gradeInputLabel = document.getElementById("grade-input-label");
  el.gradeHelpText = document.getElementById("grade-help-text");
  el.subjectNameError = document.getElementById("subject-name-error");
  el.creditsError = document.getElementById("credits-error");
  el.gradeError = document.getElementById("grade-error");
  el.courseModalClose = document.getElementById("course-modal-close");
  el.courseModalCancel = document.getElementById("course-modal-cancel");
  el.courseModalSave = document.getElementById("course-modal-save");

  el.deleteModal = document.getElementById("delete-modal");
  el.deleteModalName = document.getElementById("delete-modal-name");
  el.deleteConfirmBtn = document.getElementById("delete-confirm-btn");
  el.deleteCancelBtn = document.getElementById("delete-cancel-btn");
  el.deleteModalClose = document.getElementById("delete-modal-close");

  el.drawer = document.getElementById("detail-drawer");
  el.drawerSubjectCode = document.getElementById("drawer-subject-code");
  el.drawerSubjectName = document.getElementById("drawer-subject-name");
  el.drawerMeta = document.getElementById("drawer-meta");
  el.drawerProfessor = document.getElementById("drawer-professor");
  el.drawerOfficeHours = document.getElementById("drawer-office-hours");
  el.drawerSyllabus = document.getElementById("drawer-syllabus");
  el.drawerNotes = document.getElementById("drawer-notes");
  el.drawerClose = document.getElementById("drawer-close");
  el.drawerCancel = document.getElementById("drawer-cancel");
  el.drawerSave = document.getElementById("drawer-save");

  el.toast = document.getElementById("toast");

  el.trendChartCanvas = document.getElementById("ipk-trend-chart");
  el.trendEmpty = document.getElementById("trend-empty");
  el.distributionChartCanvas = document.getElementById("grade-distribution-chart");
  el.distributionEmpty = document.getElementById("distribution-empty");
}

/* ======================================================================
   Firestore
   ====================================================================== */

function coursesCollectionRef() {
  return collection(db, "users", currentUser.uid, "courses");
}

function subscribeToCourses() {
  if (unsubscribeCourses) unsubscribeCourses();

  const q = query(coursesCollectionRef(), orderBy("createdAt", "asc"));
  toggleLoading(true);

  unsubscribeCourses = onSnapshot(
    q,
    (snapshot) => {
      courses = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
      dataLoaded = true; // first (and every subsequent) snapshot has now arrived
      toggleLoading(false);
      render();
    },
    (error) => {
      console.error("Failed to load courses:", error);
      dataLoaded = true; // don't block chart gating forever on a failed load
      toggleLoading(false);
      el.semesterGroups.innerHTML =
        '<p class="py-8 text-center text-rust text-sm">Couldn\'t load your courses. Please refresh the page.</p>';
      el.emptyState.classList.add("hidden");
      el.noResultsState.classList.add("hidden");
    }
  );
}

async function createCourse(data) {
  await addDoc(coursesCollectionRef(), {
    subjectCode: data.subjectCode || "",
    subjectName: data.subjectName,
    credits: data.credits,
    semester: data.semester,
    period: data.period,
    isHypothetical: !!data.isHypothetical,
    includeInCalc: true,
    scoreNumber: data.scoreNumber,
    scoreLetter: data.scoreLetter,
    scoreIndex: data.scoreIndex,
    notes: { professor: "", officeHours: "", syllabus: "", studyNotes: "" },
    createdAt: serverTimestamp(),
  });
}

async function editCourse(id, data) {
  await updateDoc(doc(db, "users", currentUser.uid, "courses", id), {
    subjectCode: data.subjectCode || "",
    subjectName: data.subjectName,
    credits: data.credits,
    semester: data.semester,
    period: data.period,
    isHypothetical: !!data.isHypothetical,
    scoreNumber: data.scoreNumber,
    scoreLetter: data.scoreLetter,
    scoreIndex: data.scoreIndex,
  });
}

async function removeCourse(id) {
  await deleteDoc(doc(db, "users", currentUser.uid, "courses", id));
}

async function setIncludeInCalc(id, value) {
  await updateDoc(doc(db, "users", currentUser.uid, "courses", id), { includeInCalc: value });
}

async function saveCourseNotes(id, notes) {
  await updateDoc(doc(db, "users", currentUser.uid, "courses", id), { notes });
}

async function bulkImportCourses(rows) {
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = writeBatch(db);
    const chunk = rows.slice(i, i + CHUNK);
    chunk.forEach((row) => {
      const ref = doc(coursesCollectionRef());
      batch.set(ref, {
        subjectCode: row.subjectCode || "",
        subjectName: row.subjectName,
        credits: row.credits,
        semester: row.semester,
        period: row.period,
        isHypothetical: !!row.isHypothetical,
        includeInCalc: true,
        scoreNumber: row.scoreNumber,
        scoreLetter: row.scoreLetter,
        scoreIndex: row.scoreIndex,
        notes: {
          professor: row.professor || "",
          officeHours: row.officeHours || "",
          syllabus: row.syllabus || "",
          studyNotes: row.studyNotes || "",
        },
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();
  }
}

/* ======================================================================
   Derived data: totals, inclusion, grouping
   ====================================================================== */

function isCourseIncludable(course) {
  if (!course.isHypothetical) return true;
  return includePlanned && course.includeInCalc !== false;
}

function getCalcCourses(list) {
  return (list || courses).filter(isCourseIncludable);
}

function computeTotals(courseList) {
  let sksTotal = 0;
  let productTotal = 0;

  courseList.forEach((course) => {
    const credits = Number(course.credits) || 0;
    const index = Number(course.scoreIndex) || 0;
    sksTotal += credits;
    productTotal += credits * index;
  });

  const ipk = sksTotal > 0 ? productTotal / sksTotal : 0;
  return { sksTotal, productTotal, ipk };
}

function groupByBlock(list) {
  const map = new Map();
  list.forEach((course) => {
    const key = blockKeyOf(course);
    if (!map.has(key)) {
      map.set(key, { key, semester: course.semester || 0, period: course.period || null, courses: [] });
    }
    map.get(key).courses.push(course);
  });
  return [...map.values()].sort((a, b) => {
    if (a.semester !== b.semester) return a.semester - b.semester;
    const ap = a.period || "";
    const bp = b.period || "";
    return ap.localeCompare(bp);
  });
}

/* ======================================================================
   Filtering & sorting
   ====================================================================== */

function matchesGradeFilter(course) {
  const idx = Number(course.scoreIndex) || 0;
  switch (filters.grade) {
    case "a-only":
      return course.scoreLetter === "A";
    case "a-minus-up":
      return idx >= 3.7;
    case "b-plus-up":
      return idx >= 3.3;
    case "below-3":
      return idx < 3.0;
    case "below-2":
      return idx < 2.0;
    default:
      return true;
  }
}

function matchesCreditsFilter(course) {
  if (filters.credits === "all") return true;
  return String(Number(course.credits)) === filters.credits;
}

function matchesTypeFilter(course) {
  if (filters.type === "completed") return !course.isHypothetical;
  if (filters.type === "planned") return !!course.isHypothetical;
  return true;
}

function getVisibleCourses(list) {
  let result = list.slice();

  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    result = result.filter(
      (course) =>
        (course.subjectName || "").toLowerCase().includes(term) ||
        (course.subjectCode || "").toLowerCase().includes(term)
    );
  }

  result = result.filter(
    (course) => matchesGradeFilter(course) && matchesCreditsFilter(course) && matchesTypeFilter(course)
  );

  const { key, dir } = sortState;
  const factor = dir === "asc" ? 1 : -1;

  result.sort((a, b) => {
    switch (key) {
      case "subjectCode":
        return (a.subjectCode || "").localeCompare(b.subjectCode || "") * factor;
      case "subjectName":
        return a.subjectName.localeCompare(b.subjectName) * factor;
      case "credits":
        return (Number(a.credits) - Number(b.credits)) * factor;
      case "scoreNumber":
        return ((Number(a.scoreNumber) || 0) - (Number(b.scoreNumber) || 0)) * factor;
      case "scoreLetter":
        return (a.scoreLetter || "").localeCompare(b.scoreLetter || "") * factor;
      case "index":
        return (Number(a.scoreIndex) - Number(b.scoreIndex)) * factor;
      case "product":
        return (
          (Number(a.credits) * Number(a.scoreIndex) - Number(b.credits) * Number(b.scoreIndex)) * factor
        );
      case "createdAt":
      default: {
        const aTime = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
        const bTime = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
        return (aTime - bTime) * factor;
      }
    }
  });

  return result;
}

function refreshCreditsFilterOptions() {
  const distinct = [...new Set(courses.map((c) => Number(c.credits)).filter((n) => Number.isFinite(n)))].sort(
    (a, b) => a - b
  );
  const current = el.filterCredits.value;
  el.filterCredits.innerHTML =
    '<option value="all">Any credits</option>' +
    distinct.map((n) => `<option value="${n}">${n} SKS</option>`).join("");
  if (distinct.some((n) => String(n) === current)) el.filterCredits.value = current;
}

/* ======================================================================
   Rendering
   ====================================================================== */

function gradeBadgeClass(letter) {
  const base = (letter || "").charAt(0);
  switch (base) {
    case "A":
      return "grade-badge grade-badge-a";
    case "B":
      return "grade-badge grade-badge-b";
    case "C":
      return "grade-badge grade-badge-c";
    default:
      return "grade-badge grade-badge-d";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str === null || str === undefined ? "" : String(str);
  return div.innerHTML;
}

function render() {
  refreshCreditsFilterOptions();
  renderMetrics();
  renderSimulator();
  renderSemesterGroups();
  renderCharts();
}

function renderMetrics() {
  const calc = getCalcCourses();
  const totals = computeTotals(calc);
  const completedCount = courses.filter((c) => !c.isHypothetical).length;
  const plannedCount = courses.length - completedCount;

  el.metricTotalCourses.textContent = String(courses.length);
  el.metricTotalBreakdown.textContent = `${completedCount} completed · ${plannedCount} planned`;
  el.metricSksTotal.textContent = totals.sksTotal.toFixed(0);
  el.metricProductTotal.textContent = totals.productTotal.toFixed(2);
  el.metricIpk.textContent = totals.ipk.toFixed(2);
}

function renderSimulator() {
  if (!remainingSksManuallySet) {
    const plannedSks = courses
      .filter((c) => c.isHypothetical && c.includeInCalc !== false)
      .reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
    el.simRemainingSks.value = plannedSks > 0 ? plannedSks : "";
  }

  const targetIpk = parseFloat(el.simTargetIpk.value);
  const remainingSks = parseFloat(el.simRemainingSks.value);
  const baseline = computeTotals(courses.filter((c) => !c.isHypothetical));

  if (!Number.isFinite(targetIpk) || targetIpk <= 0) {
    el.simResultText.textContent =
      "Enter a goal GPA to see the average index you'll need across your remaining coursework.";
    return;
  }
  if (!Number.isFinite(remainingSks) || remainingSks <= 0) {
    el.simResultText.textContent =
      "Enter your remaining estimated SKS (or add planned courses below to auto-fill it).";
    return;
  }

  const requiredProduct = targetIpk * (baseline.sksTotal + remainingSks) - baseline.productTotal;
  const requiredIndex = requiredProduct / remainingSks;

  if (requiredIndex <= 0) {
    el.simResultText.innerHTML = `You've already secured enough to clear a <strong>${targetIpk.toFixed(
      2
    )}</strong> cumulative GPA — even an average of <strong>0.00</strong> across your remaining ${remainingSks} SKS would keep you there.`;
    return;
  }

  if (requiredIndex > 4.0) {
    const maxPossible = (baseline.productTotal + 4.0 * remainingSks) / (baseline.sksTotal + remainingSks);
    el.simResultText.innerHTML = `That goal isn't reachable with only ${remainingSks} SKS left — even a perfect <strong>4.00</strong> average caps your cumulative GPA at <strong>${maxPossible.toFixed(
      2
    )}</strong>. Add more remaining SKS or lower your target.`;
    return;
  }

  const grade = letterForRequiredIndex(requiredIndex);
  el.simResultText.innerHTML = `To hit a <strong>${targetIpk.toFixed(
    2
  )}</strong> cumulative GPA, you need an average of <strong>${requiredIndex.toFixed(
    2
  )}</strong> (roughly a <strong>${grade.letter}</strong>) across your remaining <strong>${remainingSks}</strong> estimated SKS.`;
}

function renderSemesterGroups() {
  const groups = groupByBlock(courses);

  if (courses.length === 0) {
    el.semesterGroups.innerHTML = "";
    el.emptyState.classList.remove("hidden");
    el.noResultsState.classList.add("hidden");
    return;
  }
  el.emptyState.classList.add("hidden");

  const calc = getCalcCourses();
  const calcIds = new Set(calc.map((c) => c.id));

  let anyVisible = false;
  const html = groups
    .map((group) => {
      const visibleRows = getVisibleCourses(group.courses);
      if (visibleRows.length > 0) anyVisible = true;

      const includedInGroup = group.courses.filter((c) => calcIds.has(c.id));
      const groupTotals = computeTotals(includedInGroup);
      const groupSks = group.courses.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);

      const completedCount = group.courses.filter((c) => !c.isHypothetical).length;
      const plannedCount = group.courses.length - completedCount;
      let typeBadge;
      if (plannedCount === 0) typeBadge = '<span class="semester-badge semester-badge-done">Completed</span>';
      else if (completedCount === 0) typeBadge = '<span class="semester-badge semester-badge-planned">Planned</span>';
      else typeBadge = '<span class="semester-badge semester-badge-mixed">Mixed</span>';

      const collapsed = collapsedSemesters.has(group.key);

      const rowsHtml =
        visibleRows.length === 0
          ? `<tr><td colspan="9" class="py-6 text-center text-sm text-slate-400">No subjects in this block match your search/filters.</td></tr>`
          : visibleRows
              .map((course) => {
                const product = (Number(course.credits) * Number(course.scoreIndex)).toFixed(2);
                const numberDisplay =
                  course.scoreNumber === null || course.scoreNumber === undefined ? "—" : course.scoreNumber;
                const included = calcIds.has(course.id);
                const checkboxDisabled = !course.isHypothetical;
                return `
        <tr class="ledger-row ${included ? "" : "ledger-row-excluded"}" data-id="${course.id}">
          <td class="px-3 py-3 text-center">
            <input type="checkbox" class="include-checkbox" data-action="toggle-include" data-id="${course.id}"
              ${course.includeInCalc !== false ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""} />
          </td>
          <td class="px-3 py-3 text-xs text-slate-500 font-mono">${escapeHtml(course.subjectCode || "—")}</td>
          <td class="px-3 py-3 text-sm font-medium text-slate-800">
            ${escapeHtml(course.subjectName)}
            ${course.isHypothetical ? '<span class="planned-pill">Planned</span>' : ""}
          </td>
          <td class="px-3 py-3 text-sm text-slate-600 font-mono text-center">${escapeHtml(course.credits)}</td>
          <td class="px-3 py-3 text-sm text-slate-600 font-mono text-center">${escapeHtml(numberDisplay)}</td>
          <td class="px-3 py-3 text-center">
            <span class="${gradeBadgeClass(course.scoreLetter)}">${escapeHtml(course.scoreLetter)}</span>
          </td>
          <td class="px-3 py-3 text-sm text-slate-600 font-mono text-center">${Number(course.scoreIndex).toFixed(2)}</td>
          <td class="px-3 py-3 text-sm font-semibold text-slate-800 font-mono text-center">${product}</td>
          <td class="px-3 py-3 text-center">
            <div class="flex items-center justify-center gap-2">
              <button type="button" class="icon-btn icon-btn-edit" data-action="edit" data-id="${course.id}" aria-label="Edit ${escapeHtml(course.subjectName)}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button type="button" class="icon-btn icon-btn-delete" data-action="delete" data-id="${course.id}" aria-label="Delete ${escapeHtml(course.subjectName)}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
              })
              .join("");

      return `
      <div class="semester-card rounded-2xl border border-slate-200 bg-white overflow-hidden mb-4" data-semester-key="${group.key}">
        <button type="button" class="semester-header w-full flex flex-wrap items-center justify-between gap-2 px-5 py-4" data-action="toggle-collapse" data-key="${group.key}">
          <div class="flex items-center gap-2.5">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 text-slate-400 chevron ${collapsed ? "chevron-collapsed" : ""}"><path d="m6 9 6 6 6-6"/></svg>
            <h3 class="font-display text-base text-ink">${blockLabelOf({ semester: group.semester, period: group.period })}</h3>
            ${typeBadge}
          </div>
          <div class="flex items-center gap-4 font-mono text-xs">
            <span class="text-slate-400">${group.courses.length} subject${group.courses.length === 1 ? "" : "s"}</span>
            <span class="text-slate-500">${groupSks} SKS</span>
            <span class="semester-ips">GPA ${groupTotals.ipk.toFixed(2)}</span>
          </div>
        </button>
        <div class="semester-body ${collapsed ? "hidden" : ""}">
          <div class="overflow-x-auto">
            <table class="w-full min-w-[860px] border-collapse">
              <thead class="bg-slate-50 text-slate-500 border-y border-slate-100">
                <tr>
                  <th class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide">Incl.</th>
                  <th data-sort="subjectCode" class="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">Code <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="subjectName" class="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">Subject Name <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="credits" class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">SKS <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="scoreNumber" class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">Number <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="scoreLetter" class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">Alphabet <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="index" class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">Index <span class="sort-arrow opacity-0">▲</span></th>
                  <th data-sort="product" class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none">SKS × Index <span class="sort-arrow opacity-0">▲</span></th>
                  <th class="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    })
    .join("");

  el.semesterGroups.innerHTML = html;
  el.noResultsState.classList.toggle("hidden", anyVisible || courses.length === 0);
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll("[data-sort]").forEach((th) => {
    const key = th.getAttribute("data-sort");
    const arrow = th.querySelector(".sort-arrow");
    if (!arrow) return;
    if (key === sortState.key) {
      arrow.textContent = sortState.dir === "asc" ? "▲" : "▼";
      arrow.classList.remove("opacity-0");
    } else {
      arrow.textContent = "▲";
      arrow.classList.add("opacity-0");
    }
  });
}

function toggleLoading(isLoading) {
  if (!el.loadingState) return;
  el.loadingState.classList.toggle("hidden", !isLoading);
  if (isLoading) {
    el.semesterGroups.innerHTML = "";
    el.emptyState.classList.add("hidden");
    el.noResultsState.classList.add("hidden");
  }
}

/* ======================================================================
   Charts
   ====================================================================== */

// --- Chart.js library load tracking -------------------------------------
// Chart.js is loaded from a CDN in a plain <script> tag. If that request
// is blocked (ad-blocker/privacy extension) or fails on a flaky
// connection, `Chart` never becomes defined and every chart render call
// was previously just silently returning — leaving a permanently blank
// box with no error and no "no data" placeholder, which is indistinguishable
// from "everything is fine, there's just nothing to draw." That's a bug in
// itself: failures should be visible. This tracks the load state and
// retries for a few seconds before giving up and showing a real message.
let chartLibraryReady = typeof Chart !== "undefined";
let chartLibraryFailed = false;
let chartLibraryPollStarted = false;
const CHART_LOAD_TIMEOUT_MS = 6000;
const CHART_POLL_INTERVAL_MS = 150;

function waitForChartLibrary() {
  if (chartLibraryReady || chartLibraryPollStarted) return;
  chartLibraryPollStarted = true;
  const start = Date.now();

  const poll = () => {
    if (typeof Chart !== "undefined") {
      chartLibraryReady = true;
      chartLibraryPollStarted = false;
      renderCharts(); // re-attempt now that the library is actually here
      return;
    }
    if (Date.now() - start > CHART_LOAD_TIMEOUT_MS) {
      chartLibraryFailed = true;
      chartLibraryPollStarted = false;
      console.error(
        "Chart.js never became available — it most likely failed to load " +
          "from the CDN (blocked by an ad-blocker/privacy extension, or no " +
          "network access to cdnjs.cloudflare.com). Check the Network tab " +
          "for a failed request to chart.umd.min.js."
      );
      showChartLoadError();
      return;
    }
    setTimeout(poll, CHART_POLL_INTERVAL_MS);
  };

  poll();
}

function showChartLoadError() {
  const message =
    "Charts couldn't load — Chart.js failed to fetch from the CDN. Check your connection or browser extensions (ad-blockers can block cdnjs.cloudflare.com), then refresh.";
  if (el.trendChartCanvas) el.trendChartCanvas.classList.add("hidden");
  if (el.trendEmpty) {
    el.trendEmpty.textContent = message;
    el.trendEmpty.classList.remove("hidden");
  }
  if (el.distributionChartCanvas) el.distributionChartCanvas.classList.add("hidden");
  if (el.distributionEmpty) {
    el.distributionEmpty.textContent = message;
    el.distributionEmpty.classList.remove("hidden");
  }
}

/**
 * Entry point for (re)rendering both charts. This is the single gate
 * everything else funnels through:
 *  - Refuses to run until auth has resolved AND the first Firestore
 *    snapshot has landed (dataLoaded), so we never race the initial page
 *    load.
 *  - Refuses to run (and instead shows a real error) if Chart.js itself
 *    never loaded, rather than silently doing nothing.
 *  - Delegates the actual Chart.js work to ensureCanvasVisible(), which
 *    waits for the canvas to actually have a non-zero layout box (instead
 *    of assuming a single requestAnimationFrame is enough) before drawing.
 */
function renderCharts() {
  if (!authReady || !dataLoaded) return;

  if (chartLibraryFailed) {
    showChartLoadError();
    return;
  }
  if (typeof Chart === "undefined") {
    waitForChartLibrary();
    return; // will call renderCharts() again once the library shows up (or times out into an error)
  }
  chartLibraryReady = true;

  ensureCanvasVisible(el.trendChartCanvas, renderTrendChart);
  ensureCanvasVisible(el.distributionChartCanvas, renderDistributionChart);
}

/**
 * Waits for `canvas` to report real layout dimensions before invoking
 * `renderFn`. Retries across animation frames (capped) rather than
 * assuming one frame is enough — covers cases where the canvas's parent
 * was just un-hidden (visibility/display toggled) in the same tick, or
 * the surrounding auth-guarded shell hasn't finished its reveal yet.
 */
function ensureCanvasVisible(canvas, renderFn, attempt = 0) {
  if (!canvas) return;

  const MAX_ATTEMPTS = 40; // ~40 frames, generous but bounded
  const hasLayout = canvas.clientWidth > 0 && canvas.clientHeight > 0;
  const isConnected = canvas.isConnected;

  if (!isConnected) return; // canvas was removed from the DOM, bail quietly

  if (!hasLayout) {
    if (attempt < MAX_ATTEMPTS) {
      requestAnimationFrame(() => ensureCanvasVisible(canvas, renderFn, attempt + 1));
    }
    return;
  }

  try {
    renderFn();
  } catch (error) {
    // A draw failure here should never take down the rest of the app —
    // log it and leave whatever chart state existed before untouched.
    console.error("Chart render failed:", error);
  }
}

/** Safely tears down a Chart.js instance, tolerating an already-dead one. */
function safeDestroyChart(instance) {
  if (!instance) return null;
  try {
    instance.destroy();
  } catch (error) {
    console.error("Chart teardown failed:", error);
  }
  return null;
}

function renderTrendChart() {
  if (typeof Chart === "undefined" || !el.trendChartCanvas) return;

  const completedGroups = groupByBlock(courses.filter((c) => !c.isHypothetical));

  if (completedGroups.length === 0) {
    trendChartInstance = safeDestroyChart(trendChartInstance);
    el.trendChartCanvas.classList.add("hidden");
    el.trendEmpty.classList.remove("hidden");
    return;
  }
  el.trendChartCanvas.classList.remove("hidden");
  el.trendEmpty.classList.add("hidden");

  const labels = [];
  const ipsSeries = [];
  const ipkSeries = [];
  let cumSks = 0;
  let cumProduct = 0;

  completedGroups.forEach((group) => {
    const totals = computeTotals(group.courses);
    cumSks += totals.sksTotal;
    cumProduct += totals.productTotal;
    labels.push(blockLabelOf({ semester: group.semester, period: group.period }));
    ipsSeries.push(Number(totals.ipk.toFixed(2)));
    ipkSeries.push(Number((cumSks > 0 ? cumProduct / cumSks : 0).toFixed(2)));
  });

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Block GPA",
          data: ipsSeries,
          borderColor: "#8A93A1",
          backgroundColor: "rgba(138,147,161,0.12)",
          borderDash: [4, 3],
          tension: 0.3,
          pointRadius: 3,
        },
        {
          label: "Cumulative GPA",
          data: ipkSeries,
          borderColor: "#A6802D",
          backgroundColor: "rgba(166,128,45,0.14)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: "#A6802D",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Prevents Chart.js from thrashing on rapid successive resize
      // events (e.g. a burst of onSnapshot updates during CSV import).
      resizeDelay: 50,
      scales: {
        y: { min: 0, max: 4, ticks: { stepSize: 1, font: { family: "IBM Plex Mono" } } },
        x: { ticks: { font: { family: "IBM Plex Mono", size: 10 } } },
      },
      plugins: {
        legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, boxWidth: 12 } },
      },
    },
  };

  try {
    if (trendChartInstance) {
      trendChartInstance.data = config.data;
      trendChartInstance.update();
    } else {
      trendChartInstance = new Chart(el.trendChartCanvas, config);
    }
  } catch (error) {
    // Canvas was likely reused/stale (e.g. a leftover instance pointing at
    // a torn-down context). Drop it and rebuild clean rather than leaving
    // the chart permanently broken.
    console.error("Trend chart init failed, rebuilding:", error);
    trendChartInstance = safeDestroyChart(trendChartInstance);
    try {
      trendChartInstance = new Chart(el.trendChartCanvas, config);
    } catch (retryError) {
      console.error("Trend chart rebuild also failed:", retryError);
    }
  }
}

function renderDistributionChart() {
  if (typeof Chart === "undefined" || !el.distributionChartCanvas) return;

  const calc = getCalcCourses();
  const counts = {};
  VALID_LETTERS.forEach((l) => (counts[l] = 0));
  calc.forEach((c) => {
    if (Object.prototype.hasOwnProperty.call(counts, c.scoreLetter)) counts[c.scoreLetter] += 1;
  });

  const activeLetters = VALID_LETTERS.filter((l) => counts[l] > 0);

  if (activeLetters.length === 0) {
    distributionChartInstance = safeDestroyChart(distributionChartInstance);
    el.distributionChartCanvas.classList.add("hidden");
    el.distributionEmpty.classList.remove("hidden");
    return;
  }
  el.distributionChartCanvas.classList.remove("hidden");
  el.distributionEmpty.classList.add("hidden");

  const config = {
    type: "doughnut",
    data: {
      labels: activeLetters,
      datasets: [
        {
          data: activeLetters.map((l) => counts[l]),
          backgroundColor: activeLetters.map((l) => GRADE_COLORS[l] || "#8A93A1"),
          borderColor: "#FAF8F3",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 50,
      cutout: "62%",
      plugins: {
        legend: { position: "bottom", labels: { font: { family: "IBM Plex Mono", size: 11 }, boxWidth: 12 } },
      },
    },
  };

  try {
    if (distributionChartInstance) {
      distributionChartInstance.data = config.data;
      distributionChartInstance.update();
    } else {
      distributionChartInstance = new Chart(el.distributionChartCanvas, config);
    }
  } catch (error) {
    console.error("Distribution chart init failed, rebuilding:", error);
    distributionChartInstance = safeDestroyChart(distributionChartInstance);
    try {
      distributionChartInstance = new Chart(el.distributionChartCanvas, config);
    } catch (retryError) {
      console.error("Distribution chart rebuild also failed:", retryError);
    }
  }
}

/**
 * Classic Chart.js gotcha: if a chart is constructed while its tab/panel
 * is backgrounded (e.g. the browser throttles layout in a hidden tab),
 * it can end up permanently mis-sized. Force a resize the moment the tab
 * becomes visible again as a cheap safety net.
 */
function handleVisibilityRecovery() {
  if (document.hidden) return;
  try {
    if (trendChartInstance) trendChartInstance.resize();
    if (distributionChartInstance) distributionChartInstance.resize();
  } catch (error) {
    console.error("Chart resize-on-visible failed:", error);
  }
}

/* ======================================================================
   Course modal (add / edit)
   ====================================================================== */

function resetCourseFormErrors() {
  [el.subjectNameError, el.creditsError, el.gradeError, el.courseSemesterError].forEach((node) => {
    if (node) {
      node.textContent = "";
      node.classList.add("hidden");
    }
  });
  [el.subjectNameInput, el.creditsInput, el.gradeInput, el.courseSemesterNumber].forEach((input) => {
    if (input) input.classList.remove("input-invalid");
  });
}

function showFieldError(input, errorNode, message) {
  if (errorNode) {
    errorNode.textContent = message;
    errorNode.classList.remove("hidden");
  }
  if (input) input.classList.add("input-invalid");
}

function syncGradeFieldLabel() {
  const isFuture = el.isHypothetical.checked;
  el.gradeInputLabel.textContent = isFuture ? "Target grade" : "Grade";
  el.gradeInput.placeholder = isFuture ? "e.g. A- (your goal)" : "91 or A-";
  el.gradeHelpText.textContent = isFuture
    ? "Enter the score or letter grade you're aiming for. You can toggle this course in or out of your GPA anytime."
    : "Enter a score from 0–100, or a letter grade (A, A-, B+, B, B-, C+, C, F).";
}

function updatePeriodFieldsUI() {
  const raw = el.courseSemesterNumber.value;
  const semesterNum = Number(raw);
  const validSemester = raw.trim() !== "" && Number.isInteger(semesterNum) && semesterNum >= 1;
  const mode = validSemester ? semesterMode(semesterNum) : "invalid";

  el.periodFlexWrapper.classList.toggle("hidden", mode !== "flexible");
  el.periodCompactNote.classList.add("hidden");
  el.periodSelectWrapper.classList.add("hidden");

  if (mode === "compact") {
    el.periodCompactNote.textContent = `Semester ${semesterNum} is a Compact Semester — shown as a single block, no period split.`;
    el.periodCompactNote.classList.remove("hidden");
  } else if (mode === "split") {
    el.periodSelectWrapper.classList.remove("hidden");
  } else if (mode === "flexible") {
    if (el.periodFlexToggle.checked) {
      el.periodSelectWrapper.classList.remove("hidden");
    } else {
      el.periodCompactNote.textContent = `Semester ${semesterNum} will be treated as a Compact block. Check the box above to split it into Period A / B instead.`;
      el.periodCompactNote.classList.remove("hidden");
    }
  }
}

function openCourseModal(mode, course) {
  resetCourseFormErrors();
  el.courseForm.reset();

  if (mode === "edit" && course) {
    editingCourseId = course.id;
    el.courseModalTitle.textContent = "Edit subject";
    el.courseModalSave.textContent = "Save changes";
    el.courseIdField.value = course.id;
    el.isHypothetical.checked = !!course.isHypothetical;
    el.courseSemesterNumber.value = course.semester || "";
    el.coursePeriod.value = course.period || "A";
    el.periodFlexToggle.checked = semesterMode(course.semester) === "flexible" && !!course.period;
    el.subjectCodeInput.value = course.subjectCode || "";
    el.subjectNameInput.value = course.subjectName;
    el.creditsInput.value = course.credits;
    el.gradeInput.value =
      course.scoreNumber !== null && course.scoreNumber !== undefined ? course.scoreNumber : course.scoreLetter;
  } else {
    editingCourseId = null;
    el.courseModalTitle.textContent = "Add subject";
    el.courseModalSave.textContent = "Add subject";
    el.courseIdField.value = "";
    el.isHypothetical.checked = false;
    el.courseSemesterNumber.value = "1";
    el.coursePeriod.value = "A";
    el.periodFlexToggle.checked = false;
  }

  syncGradeFieldLabel();
  updatePeriodFieldsUI();
  el.courseModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => el.courseModal.classList.add("modal-visible"));
  el.subjectNameInput.focus();
}

function closeCourseModal() {
  el.courseModal.classList.remove("modal-visible");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    el.courseModal.classList.add("hidden");
    el.courseForm.reset();
    resetCourseFormErrors();
    editingCourseId = null;
  }, 150);
}

async function handleCourseFormSubmit(event) {
  event.preventDefault();
  resetCourseFormErrors();

  const subjectResult = validateSubjectName(el.subjectNameInput.value);
  const creditsResult = validateCredits(el.creditsInput.value);
  const gradeResult = parseGradeInput(el.gradeInput.value);

  const semesterNum = Number(el.courseSemesterNumber.value);
  const semMode = semesterMode(semesterNum);
  const wantsSplit = semMode === "split" || (semMode === "flexible" && el.periodFlexToggle.checked);
  const periodValue = wantsSplit ? el.coursePeriod.value : null;
  const semPeriodResult = validateSemesterPeriod(el.courseSemesterNumber.value, wantsSplit, periodValue);

  let hasError = false;
  if (!subjectResult.ok) {
    showFieldError(el.subjectNameInput, el.subjectNameError, subjectResult.message);
    hasError = true;
  }
  if (!creditsResult.ok) {
    showFieldError(el.creditsInput, el.creditsError, creditsResult.message);
    hasError = true;
  }
  if (!gradeResult.ok) {
    showFieldError(el.gradeInput, el.gradeError, gradeResult.message);
    hasError = true;
  }
  if (!semPeriodResult.ok) {
    showFieldError(el.courseSemesterNumber, el.courseSemesterError, semPeriodResult.message);
    hasError = true;
  }
  if (hasError) return;

  const payload = {
    subjectCode: el.subjectCodeInput.value.trim(),
    subjectName: subjectResult.value,
    credits: creditsResult.value,
    semester: semPeriodResult.semester,
    period: semPeriodResult.period,
    isHypothetical: el.isHypothetical.checked,
    scoreNumber: gradeResult.number,
    scoreLetter: gradeResult.letter,
    scoreIndex: gradeResult.index,
  };

  el.courseModalSave.disabled = true;
  const originalLabel = el.courseModalSave.textContent;
  el.courseModalSave.textContent = "Saving…";

  try {
    if (editingCourseId) {
      await editCourse(editingCourseId, payload);
    } else {
      await createCourse(payload);
    }
    closeCourseModal();
  } catch (error) {
    console.error("Failed to save course:", error);
    showFieldError(el.gradeInput, el.gradeError, "Couldn't save this subject. Please try again.");
  } finally {
    el.courseModalSave.disabled = false;
    el.courseModalSave.textContent = originalLabel;
  }
}

/* ======================================================================
   Delete modal
   ====================================================================== */

function openDeleteModal(course) {
  deletingCourse = course;
  el.deleteModalName.textContent = course.subjectName;
  el.deleteModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => el.deleteModal.classList.add("modal-visible"));
}

function closeDeleteModal() {
  el.deleteModal.classList.remove("modal-visible");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    el.deleteModal.classList.add("hidden");
    deletingCourse = null;
  }, 150);
}

async function handleDeleteConfirm() {
  if (!deletingCourse) return;
  el.deleteConfirmBtn.disabled = true;
  el.deleteConfirmBtn.textContent = "Deleting…";
  try {
    await removeCourse(deletingCourse.id);
    closeDeleteModal();
  } catch (error) {
    console.error("Failed to delete course:", error);
  } finally {
    el.deleteConfirmBtn.disabled = false;
    el.deleteConfirmBtn.textContent = "Delete";
  }
}

/* ======================================================================
   Course detail drawer
   ====================================================================== */

function openDrawer(course) {
  drawerCourseId = course.id;
  const notes = course.notes || {};
  el.drawerSubjectCode.textContent = course.subjectCode || "";
  el.drawerSubjectName.textContent = course.subjectName;
  el.drawerMeta.textContent = `${blockLabelOf(course)} · ${course.credits} SKS${
    course.isHypothetical ? " · Planned" : ""
  }`;
  el.drawerProfessor.value = notes.professor || "";
  el.drawerOfficeHours.value = notes.officeHours || "";
  el.drawerSyllabus.value = notes.syllabus || "";
  el.drawerNotes.value = notes.studyNotes || "";

  el.drawer.classList.remove("hidden");
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => el.drawer.classList.add("modal-visible"));
}

function closeDrawer() {
  el.drawer.classList.remove("modal-visible");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    el.drawer.classList.add("hidden");
    drawerCourseId = null;
  }, 150);
}

async function handleDrawerSave() {
  if (!drawerCourseId) return;
  const notes = {
    professor: el.drawerProfessor.value.trim(),
    officeHours: el.drawerOfficeHours.value.trim(),
    syllabus: el.drawerSyllabus.value.trim(),
    studyNotes: el.drawerNotes.value.trim(),
  };
  el.drawerSave.disabled = true;
  const original = el.drawerSave.textContent;
  el.drawerSave.textContent = "Saving…";
  try {
    await saveCourseNotes(drawerCourseId, notes);
    showToast("Notes saved.");
    closeDrawer();
  } catch (error) {
    console.error("Failed to save notes:", error);
  } finally {
    el.drawerSave.disabled = false;
    el.drawerSave.textContent = original;
  }
}

/* ======================================================================
   CSV export / import
   ====================================================================== */

const CSV_HEADERS = [
  "Semester",
  "Period",
  "Code",
  "Subject Name",
  "Credits",
  "Score Number",
  "Score Letter",
  "Score Index",
  "Type",
  "Professor",
  "Office Hours",
  "Syllabus",
  "Notes",
];

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportCoursesToCsv() {
  const rows = courses.map((c) => {
    const notes = c.notes || {};
    return [
      c.semester ?? "",
      c.period || "",
      c.subjectCode || "",
      c.subjectName || "",
      c.credits ?? "",
      c.scoreNumber ?? "",
      c.scoreLetter || "",
      c.scoreIndex ?? "",
      c.isHypothetical ? "Planned" : "Completed",
      notes.professor || "",
      notes.officeHours || "",
      notes.syllabus || "",
      notes.studyNotes || "",
    ];
  });

  const csv = [CSV_HEADERS, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `gpa-ledger-transcript-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Transcript exported.");
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function findColumn(headerRow, candidates) {
  const normalized = headerRow.map((h) => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCsvForImport(text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) {
    return { valid: [], errors: ["The file needs a header row plus at least one data row."] };
  }

  const header = rows[0];
  const cols = {
    semester: findColumn(header, ["semester"]),
    period: findColumn(header, ["period"]),
    code: findColumn(header, ["code", "subject code"]),
    name: findColumn(header, ["subject name", "name"]),
    credits: findColumn(header, ["credits", "sks"]),
    scoreNumber: findColumn(header, ["score number", "number"]),
    scoreLetter: findColumn(header, ["score letter", "alphabet", "letter"]),
    type: findColumn(header, ["type"]),
    professor: findColumn(header, ["professor"]),
    officeHours: findColumn(header, ["office hours"]),
    syllabus: findColumn(header, ["syllabus"]),
    notes: findColumn(header, ["notes", "study notes"]),
  };

  if (cols.name === -1 || cols.credits === -1) {
    return { valid: [], errors: ['CSV must include at least "Subject Name" and "Credits" columns.'] };
  }

  const valid = [];
  const errors = [];

  rows.slice(1).forEach((r, i) => {
    const lineNum = i + 2;
    const rawName = r[cols.name] || "";
    const rawCredits = r[cols.credits] || "";
    const rawGrade = cols.scoreNumber !== -1 && r[cols.scoreNumber] ? r[cols.scoreNumber] : r[cols.scoreLetter] || "";
    const rawSemester = cols.semester !== -1 ? r[cols.semester] : "1";
    const rawPeriod = cols.period !== -1 ? r[cols.period] : "";
    const rawType = cols.type !== -1 ? (r[cols.type] || "").trim().toLowerCase() : "completed";

    const nameResult = validateSubjectName(rawName);
    const creditsResult = validateCredits(rawCredits);
    const gradeResult = parseGradeInput(rawGrade);
    const semPeriodResult = resolveSemesterPeriodForImport(rawSemester || "1", rawPeriod);

    if (!nameResult.ok || !creditsResult.ok || !gradeResult.ok || !semPeriodResult.ok) {
      errors.push(
        `Row ${lineNum}: ${[!nameResult.ok && nameResult.message, !creditsResult.ok && creditsResult.message, !gradeResult.ok && gradeResult.message, !semPeriodResult.ok && semPeriodResult.message]
          .filter(Boolean)
          .join(" ")}`
      );
      return;
    }

    valid.push({
      subjectCode: cols.code !== -1 ? (r[cols.code] || "").trim() : "",
      subjectName: nameResult.value,
      credits: creditsResult.value,
      semester: semPeriodResult.semester,
      period: semPeriodResult.period,
      isHypothetical: rawType.startsWith("plan"),
      scoreNumber: gradeResult.number,
      scoreLetter: gradeResult.letter,
      scoreIndex: gradeResult.index,
      professor: cols.professor !== -1 ? (r[cols.professor] || "").trim() : "",
      officeHours: cols.officeHours !== -1 ? (r[cols.officeHours] || "").trim() : "",
      syllabus: cols.syllabus !== -1 ? (r[cols.syllabus] || "").trim() : "",
      studyNotes: cols.notes !== -1 ? (r[cols.notes] || "").trim() : "",
    });
  });

  return { valid, errors };
}

function openCsvModal() {
  el.csvModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => el.csvModal.classList.add("modal-visible"));
}

function closeCsvModal() {
  el.csvModal.classList.remove("modal-visible");
  document.body.classList.remove("modal-open");
  setTimeout(() => {
    el.csvModal.classList.add("hidden");
    csvParsedRows = [];
    el.csvFileInput.value = "";
    el.csvConfirmBtn.disabled = true;
    el.csvPreview.textContent = "";
    el.csvErrors.classList.add("hidden");
  }, 150);
}

function handleCsvFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  el.csvFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    const { valid, errors } = parseCsvForImport(String(reader.result));
    csvParsedRows = valid;

    el.csvPreview.textContent =
      valid
        .slice(0, 12)
        .map(
          (r) =>
            `${blockLabelOf(r)} — ${r.subjectName} — ${r.credits} SKS — ${r.scoreLetter} (${r.isHypothetical ? "Planned" : "Completed"})`
        )
        .join("\n") + (valid.length > 12 ? `\n… and ${valid.length - 12} more` : "");

    if (errors.length > 0) {
      el.csvErrors.textContent = `${errors.length} row(s) skipped:\n` + errors.slice(0, 10).join("\n");
      el.csvErrors.classList.remove("hidden");
    } else {
      el.csvErrors.classList.add("hidden");
    }

    el.csvConfirmBtn.disabled = valid.length === 0;
    el.csvConfirmBtn.textContent = valid.length > 0 ? `Import ${valid.length} row${valid.length === 1 ? "" : "s"}` : "Import rows";
    openCsvModal();
  };
  reader.readAsText(file);
}

async function handleCsvImportConfirm() {
  if (csvParsedRows.length === 0) return;
  el.csvConfirmBtn.disabled = true;
  const original = el.csvConfirmBtn.textContent;
  el.csvConfirmBtn.textContent = "Importing…";
  try {
    await bulkImportCourses(csvParsedRows);
    showToast(`Imported ${csvParsedRows.length} course${csvParsedRows.length === 1 ? "" : "s"}.`);
    closeCsvModal();
  } catch (error) {
    console.error("CSV import failed:", error);
    el.csvErrors.textContent = "Import failed. Please try again.";
    el.csvErrors.classList.remove("hidden");
  } finally {
    el.csvConfirmBtn.disabled = false;
    el.csvConfirmBtn.textContent = original;
  }
}

/* ======================================================================
   Toast
   ====================================================================== */

let toastTimer = null;
function showToast(message) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2600);
}

/* ======================================================================
   Event wiring
   ====================================================================== */

function wireEvents() {
  if (el.addCourseBtn) el.addCourseBtn.addEventListener("click", () => openCourseModal("add"));
  if (el.isHypothetical) el.isHypothetical.addEventListener("change", syncGradeFieldLabel);
  if (el.courseSemesterNumber) el.courseSemesterNumber.addEventListener("input", updatePeriodFieldsUI);
  if (el.periodFlexToggle) el.periodFlexToggle.addEventListener("change", updatePeriodFieldsUI);

  if (el.courseForm) el.courseForm.addEventListener("submit", handleCourseFormSubmit);
  if (el.courseModalClose) el.courseModalClose.addEventListener("click", closeCourseModal);
  if (el.courseModalCancel) el.courseModalCancel.addEventListener("click", closeCourseModal);
  if (el.courseModal) {
    el.courseModal.addEventListener("click", (event) => {
      if (event.target === el.courseModal) closeCourseModal();
    });
  }

  if (el.deleteConfirmBtn) el.deleteConfirmBtn.addEventListener("click", handleDeleteConfirm);
  if (el.deleteCancelBtn) el.deleteCancelBtn.addEventListener("click", closeDeleteModal);
  if (el.deleteModalClose) el.deleteModalClose.addEventListener("click", closeDeleteModal);
  if (el.deleteModal) {
    el.deleteModal.addEventListener("click", (event) => {
      if (event.target === el.deleteModal) closeDeleteModal();
    });
  }

  if (el.drawerClose) el.drawerClose.addEventListener("click", closeDrawer);
  if (el.drawerCancel) el.drawerCancel.addEventListener("click", closeDrawer);
  if (el.drawerSave) el.drawerSave.addEventListener("click", handleDrawerSave);
  if (el.drawer) {
    el.drawer.addEventListener("click", (event) => {
      if (event.target === el.drawer) closeDrawer();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (el.courseModal && el.courseModal.classList.contains("modal-visible")) closeCourseModal();
    if (el.deleteModal && el.deleteModal.classList.contains("modal-visible")) closeDeleteModal();
    if (el.drawer && el.drawer.classList.contains("modal-visible")) closeDrawer();
    if (el.csvModal && el.csvModal.classList.contains("modal-visible")) closeCsvModal();
  });

  document.addEventListener("visibilitychange", handleVisibilityRecovery);

  if (el.semesterGroups) {
    el.semesterGroups.addEventListener("click", (event) => {
      const collapseBtn = event.target.closest("[data-action='toggle-collapse']");
      if (collapseBtn) {
        const key = collapseBtn.getAttribute("data-key");
        if (collapsedSemesters.has(key)) collapsedSemesters.delete(key);
        else collapsedSemesters.add(key);
        renderSemesterGroups();
        return;
      }

      const sortHeader = event.target.closest("[data-sort]");
      if (sortHeader) {
        const key = sortHeader.getAttribute("data-sort");
        if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        else sortState = { key, dir: "asc" };
        renderSemesterGroups();
        return;
      }

      const actionBtn = event.target.closest("[data-action='edit'], [data-action='delete']");
      if (actionBtn) {
        const id = actionBtn.getAttribute("data-id");
        const course = courses.find((c) => c.id === id);
        if (!course) return;
        if (actionBtn.dataset.action === "edit") openCourseModal("edit", course);
        if (actionBtn.dataset.action === "delete") openDeleteModal(course);
        return;
      }

      const row = event.target.closest(".ledger-row");
      if (row && !event.target.closest("input, button")) {
        const course = courses.find((c) => c.id === row.getAttribute("data-id"));
        if (course) openDrawer(course);
      }
    });

    el.semesterGroups.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-action='toggle-include']");
      if (!checkbox) return;
      const id = checkbox.getAttribute("data-id");
      setIncludeInCalc(id, checkbox.checked).catch((error) => console.error("Failed to update inclusion:", error));
    });
  }

  if (el.searchInput) {
    el.searchInput.addEventListener("input", (event) => {
      searchTerm = event.target.value;
      renderSemesterGroups();
    });
  }

  if (el.includePlannedToggle) {
    el.includePlannedToggle.checked = includePlanned;
    el.includePlannedToggle.addEventListener("change", (event) => {
      includePlanned = event.target.checked;
      render();
    });
  }

  if (el.simTargetIpk) el.simTargetIpk.addEventListener("input", renderSimulator);
  if (el.simRemainingSks) {
    el.simRemainingSks.addEventListener("input", () => {
      remainingSksManuallySet = el.simRemainingSks.value.trim() !== "";
      renderSimulator();
    });
  }

  if (el.filterGrade) el.filterGrade.addEventListener("change", () => { filters.grade = el.filterGrade.value; renderSemesterGroups(); });
  if (el.filterCredits) el.filterCredits.addEventListener("change", () => { filters.credits = el.filterCredits.value; renderSemesterGroups(); });
  if (el.filterType) el.filterType.addEventListener("change", () => { filters.type = el.filterType.value; renderSemesterGroups(); });
  if (el.filterResetBtn) {
    el.filterResetBtn.addEventListener("click", () => {
      filters = { grade: "all", credits: "all", type: "all" };
      searchTerm = "";
      el.filterGrade.value = "all";
      el.filterCredits.value = "all";
      el.filterType.value = "all";
      el.searchInput.value = "";
      renderSemesterGroups();
    });
  }

  if (el.csvExportBtn) el.csvExportBtn.addEventListener("click", exportCoursesToCsv);
  if (el.csvImportBtn) el.csvImportBtn.addEventListener("click", () => el.csvFileInput.click());
  if (el.csvFileInput) el.csvFileInput.addEventListener("change", handleCsvFileSelected);
  if (el.csvModalClose) el.csvModalClose.addEventListener("click", closeCsvModal);
  if (el.csvCancelBtn) el.csvCancelBtn.addEventListener("click", closeCsvModal);
  if (el.csvConfirmBtn) el.csvConfirmBtn.addEventListener("click", handleCsvImportConfirm);
  if (el.csvModal) {
    el.csvModal.addEventListener("click", (event) => {
      if (event.target === el.csvModal) closeCsvModal();
    });
  }
}

/* ======================================================================
   Init
   ====================================================================== */

function init(user) {
  currentUser = user;
  if (el.userEmail) el.userEmail.textContent = user.displayName || user.email;
  dataLoaded = false; // reset so charts wait for THIS user's first snapshot
  subscribeToCourses();
}

document.addEventListener("DOMContentLoaded", () => {
  cacheDom();
  wireEvents();

  onAuthStateChanged(auth, (user) => {
    if (user) {
      authReady = true;
      init(user);
    } else {
      authReady = false;
      dataLoaded = false;
      courses = [];
      trendChartInstance = safeDestroyChart(trendChartInstance);
      distributionChartInstance = safeDestroyChart(distributionChartInstance);
      if (unsubscribeCourses) {
        unsubscribeCourses();
        unsubscribeCourses = null;
      }
    }
  });
});