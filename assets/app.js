const modal = document.getElementById('estimatorModal');
const form = document.getElementById('estimateForm');
const steps = [...document.querySelectorAll('.form-step')];
const progress = document.getElementById('progressBar');
const modalCard = document.querySelector('.modal-card');
const closeButton = document.querySelector('.modal-close');
let current = 1;
let lastFocused = null;

function focusableModalElements() {
  return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.offsetParent !== null);
}

function showStep(n) {
  current = n;
  steps.forEach((step) => step.classList.toggle('active', Number(step.dataset.step) === n));
  progress.style.width = `${n * 20}%`;
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

function validStep(n) {
  const step = steps.find((item) => Number(item.dataset.step) === n);
  const fields = [...step.querySelectorAll('input,select')].filter((field) => field.name !== 'company');
  for (const field of fields) {
    if (!field.checkValidity()) {
      field.reportValidity();
      return false;
    }
  }
  return true;
}

function localEstimate(data) {
  const billMap = { 'under-100': 650, '100-175': 1050, '176-250': 1500, '251-plus': 2200 };
  const kwh = billMap[data.billRange] || 1000;
  const low = Math.max(3, Math.round(kwh / 145));
  const high = Math.max(low + 1, Math.round(kwh / 105));
  const offset = data.ownership === 'own' ? '50–85%' : 'Site dependent';
  let fit = 'Needs review';
  if (data.ownership === 'rent') fit = 'Owner approval needed';
  else if (data.roofAge === '20+ years') fit = 'Roof review first';
  else if (['Asphalt shingle', 'Metal'].includes(data.roofType)) fit = 'Promising fit';
  return { systemRange: `${low}–${high} kW`, offsetRange: offset, fitCategory: fit };
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
  if (validStep(current)) showStep(Math.min(5, current + 1));
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validStep(5)) return;
  const button = document.getElementById('submitButton');
  const error = document.getElementById('formError');
  button.disabled = true;
  button.textContent = 'Saving your estimate…';
  error.textContent = '';
  const data = Object.fromEntries(new FormData(form).entries());
  const estimate = localEstimate(data);
  const payload = { ...data, estimate, source: location.href, submittedAt: new Date().toISOString() };
  try {
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
