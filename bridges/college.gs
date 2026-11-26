var COLLEGE_TIMETABLE_PROPERTIES = {
  spreadsheetId: 'COLLEGE_SPREADSHEET_ID',
  endpointUrl: 'COLLEGE_INGEST_TIMETABLE_URL',
  bearerSecret: 'COLLEGE_INGEST_TIMETABLE_BEARER_SECRET'
};
var COLLEGE_TIMETABLE_SHEET_NAME = 'Schedule';
var COLLEGE_TIMETABLE_TIMEZONE = 'Asia/Kolkata';
var COLLEGE_TIMETABLE_HANDLER = 'syncCollegeTimetable';

/** Reads the Schedule tab and sends its display values and merged A1 ranges. */
function syncCollegeTimetable() {
  var config = getCollegeTimetableConfig_();
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  } catch (error) {
    throw new Error('Timetable sync could not open the configured spreadsheet.');
  }

  var sheet = spreadsheet.getSheetByName(COLLEGE_TIMETABLE_SHEET_NAME);
  if (!sheet) {
    throw new Error('Timetable sync could not find the Schedule tab.');
  }

  var values = [];
  var merges = [];
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow > 0 && lastColumn > 0) {
    var range = sheet.getRange(1, 1, lastRow, lastColumn);
    values = range.getDisplayValues();
    merges = range.getMergedRanges().map(function (mergedRange) {
      return mergedRange.getA1Notation();
    }).sort();
  }

  var requestOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.bearerSecret },
    payload: JSON.stringify({ values: values, merges: merges }),
    muteHttpExceptions: true,
    followRedirects: false,
    validateHttpsCertificates: true
  };

  var response;
  try {
    response = UrlFetchApp.fetch(config.endpointUrl, requestOptions);
  } catch (error) {
    // Fetch exceptions can contain request details; keep them out of logs and UI.
    throw new Error('Timetable sync failed while contacting the configured endpoint.');
  }

  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    // Do not include the response body: an endpoint or proxy may echo credentials.
    throw new Error('Timetable sync failed with HTTP ' + status + '.');
  }

  return { status: status, rows: values.length, merges: merges.length };
}

/** Replaces this bridge's daily triggers with 5:30 AM and 12:30 PM IST runs. */
function installCollegeTimetableTriggers() {
  getCollegeTimetableConfig_();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === COLLEGE_TIMETABLE_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  createCollegeTimetableTrigger_(5, 30);
  createCollegeTimetableTrigger_(12, 30);
  return 'Installed two daily timetable sync triggers near 5:30 AM and 12:30 PM IST.';
}

function createCollegeTimetableTrigger_(hour, minute) {
  ScriptApp.newTrigger(COLLEGE_TIMETABLE_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .nearMinute(minute)
    .inTimezone(COLLEGE_TIMETABLE_TIMEZONE)
    .create();
}

function getCollegeTimetableConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var config = {
    spreadsheetId: properties.getProperty(COLLEGE_TIMETABLE_PROPERTIES.spreadsheetId),
    endpointUrl: properties.getProperty(COLLEGE_TIMETABLE_PROPERTIES.endpointUrl),
    bearerSecret: properties.getProperty(COLLEGE_TIMETABLE_PROPERTIES.bearerSecret)
  };
  var missing = [];
  Object.keys(COLLEGE_TIMETABLE_PROPERTIES).forEach(function (key) {
    if (!config[key]) {
      missing.push(COLLEGE_TIMETABLE_PROPERTIES[key]);
    }
  });
  if (missing.length) {
    throw new Error('Timetable sync missing required configuration: ' + missing.join(', ') + '.');
  }
  if (!isCollegeTimetableEndpoint_(config.endpointUrl)) {
    throw new Error('Timetable sync endpoint must be an HTTPS ingest-timetable URL without query parameters.');
  }
  return config;
}

function isCollegeTimetableEndpoint_(url) {
  return /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/functions\/v1\/ingest-timetable\/?$/.test(url);
}
