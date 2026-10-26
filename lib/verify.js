/* Utility verification. Every homeowner must give at least one COMPLETE method:
     A. an electric bill upload (PDF / JPG / PNG, max 3 MB)  OR
     B. electric provider + meter number                      (or both).
   Provider without meter, or meter without provider, is rejected even if a bill is attached.
   Everything is validated here on the server; the browser check is only for convenience. */
const crypto = require('crypto');

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = {
  pdf: { mime: 'application/pdf', ext: 'pdf', declared: ['application/pdf'] },
  jpg: { mime: 'image/jpeg', ext: 'jpg', declared: ['image/jpeg', 'image/jpg', 'image/pjpeg'] },
  png: { mime: 'image/png', ext: 'png', declared: ['image/png'] },
};
const fail = (m) => { const e = new Error(m); e.status = 400; return e; };

/** Detect the real type from the file's first bytes and confirm it is complete, not merely labelled. */
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF') ? 'pdf' : 'pdf-bad';
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return buf.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2 ? 'jpg' : 'jpg-bad';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return buf.includes(Buffer.from('IEND')) && buf.includes(Buffer.from('IHDR')) ? 'png' : 'png-bad';
  }
  return null;
}
const safeName = (n) => String(n || 'bill').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'bill';

/** Decode + validate the uploaded bill. Returns null when no bill was sent. */
function checkBill(b) {
  if (b == null || b === '') return null;
  if (typeof b !== 'object' || typeof b.data !== 'string') throw fail('The bill upload could not be read. Try the file again.');
  const b64 = b.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw fail('The bill file is empty or damaged. Please choose it again.');
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 8) throw fail('The bill file is too large. The limit is 3 MB.');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw fail('The bill file is empty.');
  if (buf.length > MAX_BYTES) throw fail('The bill file is too large. The limit is 3 MB.');
  const kind = sniff(buf);
  if (!kind) throw fail('Only PDF, JPG or PNG bills are accepted.');
  if (kind.endsWith('-bad')) throw fail('The bill file looks incomplete or damaged. Please choose it again.');
  const declared = String(b.mime || '').toLowerCase().split(';')[0].trim();
  if (!TYPES[kind].declared.includes(declared)) throw fail('The file type does not match its contents. Upload a real PDF, JPG or PNG.');
  return { buf, mime: TYPES[kind].mime, ext: TYPES[kind].ext, filename: safeName(b.filename), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Provider + meter pair. Both or neither. */
function checkMeter(provider, meter) {
  const p = String(provider || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const m = String(meter || '').trim().replace(/[\s\-]/g, '').toUpperCase();
  if (!p && !m) return null;
  if (!p) throw fail('Enter your electric provider along with your meter number.');
  if (!m) throw fail('Enter your meter number along with your electric provider.');
  if (!/^[A-Z0-9]{5,20}$/.test(m)) throw fail('Meter numbers are 5 to 20 letters and numbers. Check the number on your meter or bill.');
  if (p.length < 2) throw fail('Enter your electric provider.');
  return { provider: p, meter: m };
}

/** Full rule. Throws a 400 unless at least one complete method is present. */
function validate(input) {
  const bill = checkBill(input.bill);
  const pair = checkMeter(input.electric_provider, input.meter_number);
  if (!bill && !pair) throw fail('Please verify your electric account: upload a recent bill, or enter your electric provider and meter number.');
  return { bill, pair, method: bill && pair ? 'both' : bill ? 'bill' : 'meter' };
}
module.exports = { MAX_BYTES, validate, checkBill, checkMeter, sniff };
