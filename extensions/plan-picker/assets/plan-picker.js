document.querySelectorAll('.plan-picker').forEach(function (picker) {
  // Two picker blocks load this twice; each picker is set up once.
  if (picker.dataset.planPickerReady) return;
  picker.dataset.planPickerReady = 'true';
  var radios = picker.querySelectorAll('input[name="selling_plan"]');
  var form = radios.length ? radios[0].form : null;
  if (!form) return;

  // Buy it now reads the plan from a `selling_plan` input inside the product form, and took the default
  // plan while the radios joined the form only through the `form` attribute (seen on newstand-dev). So the
  // chosen plan goes in a hidden input in the form, and the radios stop submitting one of their own.
  var chosen = document.createElement('input');
  chosen.type = 'hidden';
  chosen.name = 'selling_plan';
  form.appendChild(chosen);
  radios.forEach(function (radio) {
    radio.removeAttribute('form');
  });

  // Shows the gift fields while a giftable plan is chosen and "This is a gift" is ticked. The fields
  // are disabled otherwise, so a recipient typed earlier is never sent with a different purchase.
  var gift = picker.querySelector('[data-plan-picker-gift]');
  var toggle = gift && gift.querySelector('[data-gift-toggle]');
  var fields = gift && gift.querySelector('[data-gift-fields]');
  var email = fields && fields.querySelector('input[type="email"]');
  // A product form with `novalidate` (the dev theme's has it) let a ticked gift with no recipient into the cart.
  // While it's ticked the browser checks the form; unticked, the theme's own setting is back.
  var themeNoValidate = form.noValidate;

  function update() {
    var checked = picker.querySelector('input[name="selling_plan"]:checked');
    chosen.value = checked ? checked.value : '';
    if (!gift) return;
    var giftable = Boolean(checked && checked.dataset.giftable === 'true');
    if (!giftable) toggle.checked = false;
    gift.hidden = !giftable;
    fields.hidden = !toggle.checked;
    email.required = toggle.checked;
    form.noValidate = toggle.checked ? false : themeNoValidate;
    fields.querySelectorAll('input, textarea').forEach(function (field) {
      field.disabled = !toggle.checked;
    });
  }
  picker.addEventListener('change', update);
  update();

  // Buy it now doesn't submit the form, so the browser never checks it: stop it while the recipient's
  // email is missing or invalid.
  if (gift) {
    form.addEventListener(
      'click',
      function (event) {
        if (!toggle.checked || email.checkValidity()) return;
        if (!event.target.closest || !event.target.closest('.shopify-payment-button')) return;
        event.preventDefault();
        event.stopPropagation();
        email.reportValidity();
      },
      true,
    );
  }
});
