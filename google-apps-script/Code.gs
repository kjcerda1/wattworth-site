const SHEET_NAME = 'Leads';
const REFERRAL_ADMIN_SHEET_NAME = 'Referral Admin';
const EXPECTED_SECRET = PropertiesService.getScriptProperties().getProperty('WATTWORTH_WEBHOOK_SECRET');
const BILL_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('WATTWORTH_BILL_UPLOAD_FOLDER_ID');
const MAX_BILL_FILE_SIZE = 3 * 1024 * 1024;
const ALLOWED_BILL_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const HEADERS = ['Submitted At','Lead ID','First Name','Last Name','Email','Phone','ZIP','Electric Provider','Meter Number','Verification Method','Bill Range','Ownership','Roof Type','Roof Age','System Range','Offset Range','Fit Category','Referral Code','Referrer Name','Bill File URL','Bill Filename','Bill MIME Type','Bill SHA-256','Status','Pedro Notes','Last Contacted','Source'];
const REFERRAL_ADMIN_HEADERS = ['Referral Code','Access Token SHA-256','Status','Created At','Notes'];

function doPost(e) {
  let createdFile = null;
  try {
    const suppliedSecret = e && e.parameter && e.parameter.secret;
    if (!EXPECTED_SECRET || suppliedSecret !== EXPECTED_SECRET) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    const payload = parsePayload_(e);
    validateLead_(payload);
    const sheet = getSheet_();
    ensureHeader_(sheet);
    if (findLeadRow_(sheet, payload.leadId) > 0) {
      return json_({ ok: true, leadId: payload.leadId, duplicate: true });
    }

    if (usesBill_(payload.verificationMethod)) {
      createdFile = saveBillFile_(payload);
    }
    appendLead_(sheet, payload, createdFile);
    return json_({ ok: true, leadId: payload.leadId });
  } catch (error) {
    if (createdFile) createdFile.setTrashed(true);
    console.error(error && error.message ? error.message : error);
    return json_({ ok: false, error: 'Storage failed' });
  }
}

function doGet(e) {
  try {
    const suppliedSecret = e && e.parameter && e.parameter.secret;
    if (!EXPECTED_SECRET || suppliedSecret !== EXPECTED_SECRET) {
      return json_({ ok: false, error: 'Unauthorized' });
    }
    if ((e.parameter.action || '') !== 'referral-summary') {
      return json_({ ok: false, error: 'Unknown action' });
    }
    return json_(referralSummary_(e.parameter.accessHash || ''));
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    return json_({ ok: false, error: 'Referral lookup failed' });
  }
}

function parsePayload_(e) {
  try {
    return JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (error) {
    throw new Error('Malformed JSON');
  }
}

function validateLead_(payload) {
  const required = ['leadId','submittedAt','firstName','lastName','email','phone','zip','billRange','ownership','roofType','roofAge','verificationMethod'];
  required.forEach(function(field) {
    if (!String(payload[field] || '').trim()) throw new Error('Missing ' + field);
  });

  const method = String(payload.verificationMethod || '').trim().toLowerCase();
  const hasProvider = Boolean(String(payload.electricProvider || payload.utility || '').trim());
  const hasMeter = Boolean(String(payload.meterNumber || '').trim());
  const hasBill = Boolean(payload.billFile && payload.billFile.data);

  if (method !== 'bill' && method !== 'meter' && method !== 'both') throw new Error('Invalid verification method');
  if (usesBill_(method)) {
    if (!hasBill) throw new Error('Missing bill file');
    validateBillFile_(payload.billFile);
  }
  if (usesMeter_(method) && (!hasProvider || !hasMeter)) throw new Error('Missing meter verification details');
  if (hasBill && !usesBill_(method)) throw new Error('Bill file supplied for meter-only verification');
  if (!usesBill_(method) && !usesMeter_(method)) throw new Error('Missing verification path');
}

function usesBill_(method) {
  return method === 'bill' || method === 'both';
}

function usesMeter_(method) {
  return method === 'meter' || method === 'both';
}

function validateBillFile_(file) {
  if (ALLOWED_BILL_TYPES.indexOf(String(file.type || '')) < 0) throw new Error('Unsupported bill type');
  const size = Number(file.size || 0);
  if (!size || size > MAX_BILL_FILE_SIZE) throw new Error('Invalid bill size');
  const bytes = Utilities.base64Decode(file.data);
  if (!bytes.length || bytes.length > MAX_BILL_FILE_SIZE) throw new Error('Invalid bill data');
  if (Math.abs(bytes.length - size) > 2) throw new Error('Bill size mismatch');
  const detected = detectedType_(bytes);
  if (!detected || detected !== file.type) throw new Error('Bill MIME mismatch');
  return bytes;
}

function detectedType_(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes.length >= 8 && bytes[0] === -119 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === -1 && bytes[1] === -40 && bytes[2] === -1) return 'image/jpeg';
  return '';
}

function getSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('WATTWORTH_SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Missing WATTWORTH_SPREADSHEET_ID');
  return SpreadsheetApp.openById(spreadsheetId);
}

function getSheet_() {
  const spreadsheet = getSpreadsheet_();
  return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
}

function getReferralAdminSheet_() {
  const spreadsheet = getSpreadsheet_();
  return spreadsheet.getSheetByName(REFERRAL_ADMIN_SHEET_NAME) || spreadsheet.insertSheet(REFERRAL_ADMIN_SHEET_NAME);
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
}

function ensureReferralAdminHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow(REFERRAL_ADMIN_HEADERS);
  sheet.setFrozenRows(1);
}

function findLeadRow_(sheet, leadId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i][0] || '') === String(leadId || '')) return i + 2;
  }
  return 0;
}

function appendLead_(sheet, payload, billFile) {
  const bill = payload.billFile || {};
  sheet.appendRow([
    payload.submittedAt || new Date().toISOString(),
    payload.leadId || '',
    payload.firstName || '',
    payload.lastName || '',
    payload.email || '',
    payload.phone || '',
    payload.zip || '',
    payload.electricProvider || payload.utility || '',
    payload.meterNumber || '',
    payload.verificationMethod || '',
    payload.billRange || '',
    payload.ownership || '',
    payload.roofType || '',
    payload.roofAge || '',
    payload.estimate && payload.estimate.systemRange || '',
    payload.estimate && payload.estimate.offsetRange || '',
    payload.estimate && payload.estimate.fitCategory || '',
    payload.referralCode || '',
    payload.referrerName || '',
    billFile ? billFile.getUrl() : '',
    billFile ? bill.name || '' : '',
    billFile ? bill.type || '' : '',
    billFile ? bill.sha256 || '' : '',
    'Pending',
    '',
    '',
    payload.source || ''
  ]);
}

function saveBillFile_(payload) {
  if (!BILL_FOLDER_ID) throw new Error('Missing WATTWORTH_BILL_UPLOAD_FOLDER_ID');
  const bytes = validateBillFile_(payload.billFile);
  const folder = DriveApp.getFolderById(BILL_FOLDER_ID);
  const safeLeadId = sanitizeName_(payload.leadId || 'lead');
  const safeName = sanitizeName_(payload.billFile.name || 'electric-bill');
  const blob = Utilities.newBlob(bytes, payload.billFile.type, safeLeadId + '-' + Date.now() + '-' + safeName);
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    return file;
  } catch (error) {
    file.setTrashed(true);
    throw error;
  }
}

function sanitizeName_(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 180) || 'file';
}

function referralSummary_(accessHash) {
  const hash = String(accessHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, error: 'Dashboard access was not found.' };
  const adminSheet = getReferralAdminSheet_();
  ensureReferralAdminHeader_(adminSheet);
  const referralCode = referralCodeForAccessHash_(adminSheet, hash);
  if (!referralCode) return { ok: false, error: 'Dashboard access was not found.' };

  const sheet = getSheet_();
  ensureHeader_(sheet);
  const values = sheet.getDataRange().getValues();
  const header = values.shift() || [];
  const idx = indexMap_(header);
  const counts = { total: 0, pending: 0, qualified: 0, completed: 0 };
  values.forEach(function(row) {
    if (String(row[idx['Referral Code']] || '').trim().toUpperCase() !== referralCode) return;
    counts.total += 1;
    const status = String(row[idx.Status] || 'Pending').toLowerCase();
    if (status.indexOf('complete') >= 0 || status.indexOf('reward') >= 0 || status.indexOf('closed') >= 0) counts.completed += 1;
    else if (status.indexOf('qualified') >= 0) counts.qualified += 1;
    else counts.pending += 1;
  });
  return { ok: true, counts: counts };
}

function referralCodeForAccessHash_(sheet, accessHash) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const values = sheet.getRange(2, 1, lastRow - 1, REFERRAL_ADMIN_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i += 1) {
    const referralCode = String(values[i][0] || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const storedHash = String(values[i][1] || '').trim().toLowerCase();
    const status = String(values[i][2] || 'Active').trim().toLowerCase();
    if (referralCode && status !== 'disabled' && constantTimeEqual_(storedHash, accessHash)) return referralCode;
  }
  return '';
}

function constantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function indexMap_(header) {
  return header.reduce(function(map, name, index) {
    map[name] = index;
    return map;
  }, {});
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}