// Shows the gift fields while a giftable plan is chosen and "This is a gift" is ticked. The fields
// are disabled otherwise, so a recipient typed earlier is never sent with a different purchase.
document.querySelectorAll('[data-plan-picker-gift]').forEach(function (gift) {
  var picker = gift.closest('.plan-picker');
  var toggle = gift.querySelector('[data-gift-toggle]');
  var fields = gift.querySelector('[data-gift-fields]');
  var email = fields.querySelector('input[type="email"]');
  function update() {
    var chosen = picker.querySelector('input[name="selling_plan"]:checked');
    var giftable = Boolean(chosen && chosen.dataset.giftable === 'true');
    if (!giftable) toggle.checked = false;
    gift.hidden = !giftable;
    fields.hidden = !toggle.checked;
    email.required = toggle.checked;
    fields.querySelectorAll('input, textarea').forEach(function (field) {
      field.disabled = !toggle.checked;
    });
  }
  picker.addEventListener('change', update);
  update();
});
