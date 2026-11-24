"use strict";

var MS_PER_HOUR = 3600 * 1000;
var MS_PER_DAY = 24 * MS_PER_HOUR;

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatDateKey(year, month, day) {
  return year + "-" + pad2(month) + "-" + pad2(day);
}

function daysInMonth(year, month) {
  // month is 1..12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampResetDay(year, month, resetDay) {
  var maxDay = daysInMonth(year, month);
  var d = Math.round(Number(resetDay) || 1);
  if (d < 1) d = 1;
  if (d > maxDay) d = maxDay;
  return d;
}

function getLocalParts(utcMs, tzOffsetHours) {
  var offsetMs = (Number(tzOffsetHours) || 0) * MS_PER_HOUR;
  var shifted = new Date(utcMs + offsetMs);
  var year = shifted.getUTCFullYear();
  var month = shifted.getUTCMonth() + 1;
  var day = shifted.getUTCDate();
  return {
    year: year,
    month: month,
    day: day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    dateKey: formatDateKey(year, month, day)
  };
}

function localMidnightToUtcMs(year, month, day, tzOffsetHours) {
  var offsetMs = (Number(tzOffsetHours) || 0) * MS_PER_HOUR;
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs;
}

function shiftYearMonth(year, month, deltaMonths) {
  var zeroBased = (year * 12 + (month - 1)) + deltaMonths;
  var newYear = Math.floor(zeroBased / 12);
  var newMonth = (zeroBased % 12 + 12) % 12 + 1;
  return { year: newYear, month: newMonth };
}

function computeBillingCycle(resetDay, nowMs, tzOffsetHours) {
  var tz = Number.isFinite(Number(tzOffsetHours)) ? Number(tzOffsetHours) : 8;
  var rd = Math.round(Number(resetDay) || 1);
  if (rd < 1) rd = 1;
  if (rd > 31) rd = 31;

  var now = getLocalParts(nowMs, tz);
  var thisMonthReset = clampResetDay(now.year, now.month, rd);

  var startYear, startMonth, startDay;
  var endYear, endMonth, endDay;

  if (now.day >= thisMonthReset) {
    startYear = now.year;
    startMonth = now.month;
    startDay = thisMonthReset;
    var nextYM = shiftYearMonth(now.year, now.month, 1);
    endYear = nextYM.year;
    endMonth = nextYM.month;
    endDay = clampResetDay(endYear, endMonth, rd);
  } else {
    var prevYM = shiftYearMonth(now.year, now.month, -1);
    startYear = prevYM.year;
    startMonth = prevYM.month;
    startDay = clampResetDay(startYear, startMonth, rd);
    endYear = now.year;
    endMonth = now.month;
    endDay = thisMonthReset;
  }

  var startMs = localMidnightToUtcMs(startYear, startMonth, startDay, tz);
  var endMs = localMidnightToUtcMs(endYear, endMonth, endDay, tz);
  var totalDays = Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY));
  var elapsedFraction = Math.max(0, Math.min(1, (nowMs - startMs) / (endMs - startMs)));
  var elapsedDaysFloat = Math.max(0.01, (nowMs - startMs) / MS_PER_DAY);
  var remainingDays = Math.max(0, Math.ceil((endMs - nowMs) / MS_PER_DAY));

  var startDateKey = formatDateKey(startYear, startMonth, startDay);
  var endDateKey = formatDateKey(endYear, endMonth, endDay);

  return {
    resetDay: rd,
    cycleKey: startDateKey,
    startDateKey: startDateKey,
    endDateKey: endDateKey,
    todayDateKey: now.dateKey,
    startMs: startMs,
    endMs: endMs,
    totalDays: totalDays,
    elapsedDays: Math.min(totalDays, Math.max(1, Math.floor((nowMs - startMs) / MS_PER_DAY) + 1)),
    elapsedDaysFloat: elapsedDaysFloat,
    elapsedFraction: elapsedFraction,
    remainingDays: remainingDays,
    timezoneOffset: tz
  };
}

function parseDateKeyToUtcDay(dateKey) {
  var m = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function enumerateDateKeys(startDateKey, endDateKeyInclusive) {
  var s = parseDateKeyToUtcDay(startDateKey);
  var e = parseDateKeyToUtcDay(endDateKeyInclusive);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) return [];
  var out = [];
  for (var t = s; t <= e; t += MS_PER_DAY) {
    var d = new Date(t);
    out.push(formatDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    if (out.length > 400) break;
  }
  return out;
}

function dateKeyDaysAgo(nowMs, daysAgo, tzOffsetHours) {
  return getLocalParts(nowMs - daysAgo * MS_PER_DAY, tzOffsetHours).dateKey;
}

module.exports = {
  MS_PER_DAY: MS_PER_DAY,
  daysInMonth: daysInMonth,
  clampResetDay: clampResetDay,
  getLocalParts: getLocalParts,
  computeBillingCycle: computeBillingCycle,
  enumerateDateKeys: enumerateDateKeys,
  dateKeyDaysAgo: dateKeyDaysAgo
};
