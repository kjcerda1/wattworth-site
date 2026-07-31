const modal = document.getElementById('estimatorModal');
const form = document.getElementById('estimateForm');
const steps = [...document.querySelectorAll('.form-step')];
const progress = document.getElementById('progressBar');
const modalCard = document.querySelector('.modal-card');
const closeButton = document.querySelector('.modal-close');
const verificationError = document.getElementById('verificationError');
const totalSteps = steps.length;
const submissionId = (crypto.randomUUID && crypto.randomUUID()) || ('WW-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const maxBillFileSize = 3 * 1024 * 1024;
const allowedBillTypes = ['application/pdf', 'image/png', 'image/jpeg'];
let current = 1;
let lastFocused = null;

function focusableModalElements() {
  return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null);
}

function showStep(n) {
  current = n;
  steps.forEach((step) => step.classList.toggle('active', Number(step.dataset.step) === n));
  progress.style.width = ((n / totalSteps) * 100) + '%';
  modalCard.scrollTop = 0;
}

function openEstimator() {
  lastFocused = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  showStep(1);
  closeButton.focus();
}

function closeEstimator() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function billFileStatus(field) {
  const file = field.files && field.files[0];
  field.setCustomValidity('');
  if (!file) return { present: false, valid: false, message: '' };
  if (file.size > maxBillFileSize) field.setCustomValidity('Please attach a bill file smaller than 3 MB.');
  else if (!allowedBillTypes.includes(file.type)) field.setCustomValidity('Please attach a PDF, PNG, or JPG bill file.');
  return { present: true, valid: field.checkValidity(), message: field.validationMessage };
}

function meterDetailsComplete() {
  return Boolean(form.elements.electricProvider.value.trim() && form.elements.meterNumber.value.trim());
}

function verificationState() {
  const bill = billFileStatus(form.elements.billUpload);
  const meterComplete = meterDetailsComplete();
  const providerPresent = Boolean(form.elements.electricProvider.value.trim());
  const meterPresent = Boolean(form.elements.meterNumber.value.trim());
  let method = '';
  if (bill.valid && meterComplete) method = 'both';
  else if (bill.valid) method = 'bill';
  else if (meterComplete) method = 'meter';
  return { bill, meterComplete, providerPresent, meterPresent, method };
}

function validateVerificationStep(showMessage) {
  const state = verificationState();
  if (verificationError) verificationError.textContent = '';
  if (state.bill.present && !state.bill.valid && state.meterComplete) {
    if (showMessage && verificationError) {
      form.elements.billUpload.value = '';
      form.elements.verificationPath.value = 'meter';
      verificationError.textContent = 'The selected bill file will not be uploaded. Your meter number and electric provider can verify this request instead.';
    }
    return !showMessage;
  }
  if (state.method) return true;
  let message = 'Provide either a valid electric bill or both your electric provider and meter number.';
  if (state.bill.present && !state.bill.valid) message = state.bill.message + ' You can remove it or enter both meter details instead.';
  else if (state.providerPresent && !state.meterPresent) message = 'Enter the meter number for this electric provider, or upload a valid electric bill.';
  else if (state.meterPresent && !state.providerPresent) message = 'Enter the electric provider for this meter number, or upload a valid electric bill.';
  if (verificationError) verificationError.textContent = message;
  if (showMessage) {
    const focusTarget = !state.providerPresent && state.meterPresent ? form.elements.electricProvider : !state.meterPresent && state.providerPresent ? form.elements.meterNumber : form.elements.billUpload;
    focusTarget.focus();
  }
  return false;
}

function validStep(n) {
  if (n === 3) return validateVerificationStep(true);
  const step = steps.find((item) => Number(item.dataset.step) === n);
  const fields = [...step.querySelectorAll('input,select')].filter((field) => field.name !== 'company' && field.name !== 'billUpload');
  for (const field of fields) {
    if (!field.checkValidity()) {
      field.reportValidity();
      return false;
    }
  }
  return true;
}

function readBillFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const data = result.includes(',') ? result.split(',')[1] : result;
      resolve({ name: file.name, type: file.type, size: file.size, data });
    };
    reader.onerror = () => reject(new Error('We could not read the attached bill. Please try that upload again.'));
    reader.readAsDataURL(file);
  });
}

function localEstimate(data) {
  const billMap = { 'under-100': 650, '100-175': 1050, '176-250': 1500, '251-plus': 2200 };
  const kwh = billMap[data.billRange] || 1000;
  const low = Math.max(3, Math.round(kwh / 145));
  const high = Math.max(low + 1, Math.round(kwh / 105));
  const offset = data.ownership === 'own' ? '50-85%' : 'Site dependent';
  let fit = 'Needs review';
  if (data.ownership === 'rent') fit = 'Owner approval needed';
  else if (data.roofAge === '20+ years') fit = 'Roof review first';
  else if (['Asphalt shingle', 'Metal'].includes(data.roofType)) fit = 'Promising fit';
  return { systemRange: low + '-' + high + ' kW', offsetRange: offset, fitCategory: fit };
}

function submissionError(error) {
  if (error instanceof TypeError || error.message === 'Failed to fetch') {
    return 'We could not reach the secure lead service. Please check your connection and try again.';
  }
  return error.message || 'We could not save your request. Please try again.';
}

document.querySelectorAll('[data-open-estimator]').forEach((button) => button.addEventListener('click', openEstimator));
document.querySelectorAll('[data-close-estimator]').forEach((button) => button.addEventListener('click', closeEstimator));
document.querySelectorAll('.form-next').forEach((button) => button.addEventListener('click', () => {
  if (validStep(current)) showStep(Math.min(totalSteps, current + 1));
}));
document.querySelectorAll('.form-back').forEach((button) => button.addEventListener('click', () => showStep(Math.max(1, current - 1))));

document.addEventListener('keydown', (event) => {
  if (!modal.classList.contains('open')) return;
  if (event.key === 'Escape') {
    closeEstimator();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableModalElements();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

form.addEventListener('change', (event) => {
  if (['billUpload', 'electricProvider', 'meterNumber', 'verificationPath'].includes(event.target.name)) validateVerificationStep(false);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validStep(totalSteps) || !validateVerificationStep(true)) return;
  const button = document.getElementById('submitButton');
  const error = document.getElementById('formError');
  button.disabled = true;
  button.textContent = 'Saving your estimate...';
  error.textContent = '';
  try {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    delete data.billUpload;
    const state = verificationState();
    data.verificationMethod = state.method;
    const billUpload = form.elements.billUpload.files[0];
    let billFile;
    if (state.bill.valid && billUpload) billFile = await readBillFile(billUpload);
    const estimate = localEstimate(data);
    const payload = { ...data, submissionId, estimate, source: location.href, submittedAt: new Date().toISOString() };
    if (billFile) payload.billFile = billFile;
    const response = await fetch('/api/submit-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'We could not save your request. Please try again.');
    if (!result.leadId) throw new Error('We could not confirm that your request was saved. Please try again.');
    document.getElementById('resultName').textContent = data.firstName;
    document.getElementById('systemRange').textContent = estimate.systemRange;
    document.getElementById('offsetRange').textContent = estimate.offsetRange;
    document.getElementById('fitCategory').textContent = estimate.fitCategory;
    form.hidden = true;
    document.querySelector('.progress').hidden = true;
    document.getElementById('resultPanel').hidden = false;
  } catch (errorValue) {
    error.textContent = submissionError(errorValue);
  } finally {
    button.disabled = false;
    button.textContent = 'Generate my estimate';
  }
});

document.getElementById('year').textContent = new Date().getFullYear();