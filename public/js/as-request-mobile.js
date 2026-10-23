/* Mobile presentation only. Submission and files stay in as-request.js. */
(() => {
  'use strict';
  const requestForm = document.getElementById('as-request-form');
  if (!requestForm || typeof window.matchMedia !== 'function') return;

  const viewport = window.matchMedia('(max-width: 767px)');
  const panels = [...requestForm.querySelectorAll('[data-as-step]')];
  const heading = document.getElementById('as-step-title');
  const counter = document.getElementById('as-step-count');
  const next = document.getElementById('as-step-next');
  const back = document.getElementById('as-step-back');
  const actions = requestForm.querySelector('.as-mobile-actions');
  const submit = requestForm.querySelector('button[type="submit"]');
  const submitParent = submit.parentNode;
  const submitAfter = submit.nextSibling;
  const symptom = document.getElementById('symptoms');
  const choices = [...requestForm.querySelectorAll('[data-as-symptom]')];
  const details = document.getElementById('as-symptom-details');
  const toggle = document.getElementById('as-details-toggle');
  const result = document.getElementById('request-result');
  const titles = ['제품·현장 정보를 입력해 주세요', '고장 증상을 선택해 주세요', '사진 첨부 및 동의를 확인해 주세요'];
  const originalNoValidate = requestForm.noValidate;
  let step = 1;
  let selectedType = '';
  let expanded = false;

  const mobile = () => viewport.matches;
  const busy = () => requestForm.dataset.asBusy === 'true';

  function setDetails(open) {
    expanded = open;
    details.hidden = mobile() && !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
  }

  function showStep(value, focus = true) {
    step = Math.max(1, Math.min(3, value));
    requestForm.dataset.asStep = String(step);
    panels.forEach(panel => { panel.hidden = mobile() && Number(panel.dataset.asStep) !== step; });
    heading.textContent = titles[step - 1];
    counter.textContent = step + ' / 3단계';
    back.hidden = step === 1;
    next.hidden = step === 3;
    submit.hidden = mobile() && step !== 3;
    setDetails(expanded);
    if (mobile() && focus) {
      heading.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  function invalidField(scope) {
    return [...scope.querySelectorAll('input,select,textarea')]
      .find(control => !control.disabled && control.willValidate && !control.checkValidity());
  }

  function revealInvalid(control) {
    const panel = control.closest('[data-as-step]');
    if (panel) showStep(Number(panel.dataset.asStep));
    if (details.contains(control)) setDetails(true);
    control.focus();
    control.reportValidity();
  }

  function advance() {
    if (busy()) return;
    const invalid = invalidField(panels[step - 1]);
    if (invalid) return revealInvalid(invalid);
    showStep(step + 1);
  }

  function paintChoices() {
    choices.forEach(choice => choice.setAttribute('aria-pressed', String(choice.dataset.asSymptom === selectedType)));
  }

  choices.forEach(choice => choice.addEventListener('click', () => {
    if (busy()) return;
    // The backend continues receiving one existing "symptoms" field.
    // Keep additional text when changing a selected symptom category.
    let description = symptom.value;
    const oldPrefix = selectedType ? '고장 유형: ' + selectedType : '';
    if (oldPrefix && (description === oldPrefix || description.startsWith(oldPrefix + '\n'))) {
      description = description.slice(oldPrefix.length).replace(/^\n/, '');
    }
    const type = choice.dataset.asSymptom;
    selectedType = selectedType === type ? '' : type;
    const prefix = selectedType ? '고장 유형: ' + selectedType : '';
    symptom.value = [prefix, description].filter(Boolean).join('\n');
    symptom.dispatchEvent(new Event('input', { bubbles: true }));
    paintChoices();
  }));

  toggle.addEventListener('click', () => { if (!busy()) setDetails(!expanded); });
  next.addEventListener('click', advance);
  back.addEventListener('click', () => { if (!busy()) showStep(step - 1); });

  // Capture runs before the existing uploader; hidden required fields are
  // revealed before native validation can focus them.
  requestForm.addEventListener('submit', event => {
    if (!mobile()) return;
    if (busy()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (step < 3) {
      event.preventDefault();
      event.stopImmediatePropagation();
      advance();
      return;
    }
    const invalid = invalidField(requestForm);
    if (invalid) {
      event.preventDefault();
      event.stopImmediatePropagation();
      revealInvalid(invalid);
    }
  }, true);

  requestForm.addEventListener('as:statechange', () => {
    next.disabled = back.disabled = toggle.disabled = busy();
    choices.forEach(choice => { choice.disabled = busy(); });
    if (mobile() && result.textContent) result.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });

  requestForm.addEventListener('reset', () => {
    selectedType = '';
    paintChoices();
    setDetails(false);
    // Retain the final step so the server-confirmed result remains visible.
  });

  function applyLayout() {
    document.body.classList.toggle('as-mobile', mobile());
    requestForm.noValidate = mobile() || originalNoValidate;
    if (mobile()) actions.appendChild(submit);
    else submitParent.insertBefore(submit, submitAfter);
    showStep(step, false);
  }
  if (viewport.addEventListener) viewport.addEventListener('change', applyLayout);
  else viewport.addListener(applyLayout);
  applyLayout();
})();
