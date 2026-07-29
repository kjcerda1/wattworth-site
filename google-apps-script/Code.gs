const SHEET_NAME = 'Leads';
const EXPECTED_SECRET = PropertiesService.getScriptProperties().getProperty('WATTWORTH_WEBHOOK_SECRET');

function doPost(e) {
  try {
    const suppliedSecret = e && e.parameter && e.parameter.secret;
    const payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (!EXPECTED_SECRET || suppliedSecret !== EXPECTED_SECRET) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    const sheet = getSheet_();
    ensureHeader_(sheet);
    sheet.appendRow([
      payload.submittedAt || new Date().toISOString(),
      payload.leadId || '',
      payload.firstName || '',
      payload.lastName || '',
      payload.email || '',
      payload.phone || '',
      payload.zip || '',
      payload.utility || '',
      payload.billRange || '',
      payload.ownership || '',
      payload.roofType || '',
      payload.roofAge || '',
      payload.estimate && payload.estimate.systemRange || '',
      payload.estimate && payload.estimate.offsetRange || '',
      payload.estimate && payload.estimate.fitCategory || '',
      'New',
      '',
      '',
      payload.source || ''
    ]);
    return json_({ ok: true, leadId: payload.leadId || '' });
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: 'Storage failed' });
  }
}

function getSheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('WATTWORTH_SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('Missing WATTWORTH_SPREADSHEET_ID');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow(['Submitted At','Lead ID','First Name','Last Name','Email','Phone','ZIP','Utility','Bill Range','Ownership','Roof Type','Roof Age','System Range','Offset Range','Fit Category','Status','Pedro Notes','Last Contacted','Source']);
  sheet.setFrozenRows(1);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
