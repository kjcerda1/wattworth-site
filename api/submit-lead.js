const crypto = require('crypto');

const REQUIRED = ['firstName','lastName','email','phone','zip','billRange','ownership','roofType','roofAge','consent'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BILL_FILE_SIZE = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_BILL_FILE_SIZE / 3) * 4 + 16;
const ALLOWED_BILL_TYPES = new Set(['application/pdf','image/png','image/jpeg']);
const LEAD_ID = /^[A-Za-z0-9_-]{8,80}$/;

function clean(value, max = 250) {
  return String(value ?? '').trim().slice(0, max);
}

function sanitizeFilename(value) {
  const cleaned = clean(value, 180).replace(/[\\/:*?"<>|\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'electric-bill';
}

function leadIdFromSubmission(value) {
  const supplied = clean(value, 80).replace(/[^A-Za-z0-9_-]/g, '');
  if (LEAD_ID.test(supplied)) return supplied;
  return 'WW-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function decodeBase64(data) {
  const value = clean(data, MAX_BASE64_LENGTH);
  if (!value || value.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const buffer = Buffer.from(value, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function detectedType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  return '';
}

function validateBillFile(file) {
  if (!file || typeof file !== 'object') return { present: false, valid: false, error: 'Please attach a recent electric bill.' };
  const name = sanitizeFilename(file.name);
  const claimedType = clean(file.type, 80);
  const declaredSize = Number(file.size);
  if (!ALLOWED_BILL_TYPES.has(claimedType)) return { present: true, valid: false, error: 'Please attach a PDF, PNG, or JPG electric bill.' };
  if (!Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > MAX_BILL_FILE_SIZE) return { present: true, valid: false, error: 'Please attach a bill file smaller than 3 MB.' };
  const buffer = decodeBase64(file.data);
  if (!buffer) return { present: true, valid: false, error: 'The attached bill could not be read securely.' };
  if (buffer.length <= 0 || buffer.length > MAX_BILL_FILE_SIZE) return { present: true, valid: false, error: 'Please attach a bill file smaller than 3 MB.' };
  if (Math.abs(buffer.length - declaredSize) > 2) return { present: true, valid: false, error: 'The attached bill size did not match the upload metadata.' };
  const type = detectedType(buffer);
  if (!type || type !== claimedType) return { present: true, valid: false, error: 'The attached bill type did not match its contents.' };
  return { present: true, valid: true, file: { name, type, size: buffer.length, data: clean(file.data, MAX_BASE64_LENGTH), sha256: crypto.createHash('sha256').update(buffer).digest('hex') } };
}

function verificationFrom(body) {
  const electricProvider = clean(body.electricProvider || body.utility, 120);
  const meterNumber = clean(body.meterNumber, 80);
  const meterComplete = Boolean(electricProvider && meterNumber);
  const bill = validateBillFile(body.billFile);
  if (bill.valid && meterComplete) return { ok: true, method: 'both', electricProvider, meterNumber, billFile: bill.file };
  if (bill.valid) return { ok: true, method: 'bill', electricProvider, meterNumber: '', billFile: bill.file };
  if (meterComplete) return { ok: true, method: 'meter', electricProvider, meterNumber };
  if (bill.present && !bill.valid) return { ok: false, error: bill.error + ' You can remove it or provide both electric provider and meter number instead.' };
  if (electricProvider && !meterNumber) return { ok: false, error: 'Enter the meter number for this electric provider, or upload a valid electric bill.' };
  if (meterNumber && !electricProvider) return { ok: false, error: 'Enter the electric provider for this meter number, or upload a valid electric bill.' };
  return { ok: false, error: 'Provide either a valid electric bill or both electric provider and meter number.' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (clean(body.company)) return res.status(200).json({ ok: true });

  for (const field of REQUIRED) {
    if (!clean(body[field])) return res.status(400).json({ error: 'Missing required field: ' + field + '.' });
  }
  if (!EMAIL.test(clean(body.email))) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!/^\d{5}$/.test(clean(body.zip))) return res.status(400).json({ error: 'Please enter a valid 5-digit ZIP code.' });

  const verification = verificationFrom(body);
  if (!verification.ok) return res.status(400).json({ error: verification.error });

  const leadId = leadIdFromSubmission(body.submissionId);
  const lead = {
    leadId,
    submittedAt: new Date().toISOString(),
    firstName: clean(body.firstName, 80),
    lastName: clean(body.lastName, 80),
    email: clean(body.email, 160),
    phone: clean(body.phone, 40),
    zip: clean(body.zip, 5),
    electricProvider: verification.electricProvider,
    meterNumber: verification.meterNumber,
    verificationMethod: verification.method,
    billRange: clean(body.billRange, 40),
    ownership: clean(body.ownership, 20),
    roofType: clean(body.roofType, 60),
    roofAge: clean(body.roofAge, 40),
    referralCode: clean(body.referralCode, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
    referrerName: clean(body.referrerName, 120),
    consent: true,
    estimate: body.estimate || {},
    source: clean(body.source, 500),
  };
  if (verification.billFile) lead.billFile = verification.billFile;

  const webhook = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.WATTWORTH_WEBHOOK_SECRET;
  if (!webhook || !secret) return res.status(503).json({ error: 'Lead storage is not configured yet.' });

  try {
    const target = new URL(webhook);
    target.searchParams.set('secret', secret);
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    });
    if (!response.ok) throw new Error('Storage returned ' + response.status);
    const stored = await response.json().catch(() => ({ ok: false }));
    if (!stored.ok) throw new Error(stored.error || 'Storage rejected lead');
    return res.status(201).json({ ok: true, leadId: lead.leadId });
  } catch (error) {
    console.error('lead_storage_failed', { message: error.message, leadId: lead.leadId });
    return res.status(502).json({ error: 'We could not securely save your request. Please try again.' });
  }
};