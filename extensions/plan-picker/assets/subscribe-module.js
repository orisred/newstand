document.querySelectorAll('[data-subscribe-module]').forEach(function (form) {
  var status = form.querySelector('[data-subscribe-status]');
  var button = form.querySelector('button[type="submit"]');

  function say(text, link) {
    status.textContent = text + ' ';
    if (!link) return;
    var a = document.createElement('a');
    a.href = form.dataset.cartUrl;
    a.textContent = link;
    status.appendChild(a);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var plan = form.querySelector('input[name="selling_plan"]:checked');
    if (!plan) return;
    // The gift fields are disabled unless ticked, so what's enabled is what's sent.
    var properties = {};
    form.querySelectorAll('[name^="properties["]:not(:disabled)').forEach(function (field) {
      if (field.value) properties[field.name.slice(11, -1)] = field.value;
    });
    // A theme with a cart drawer or notification (Dawn's) renders it from the sections the add returns.
    var cart = document.querySelector('cart-drawer, cart-notification');
    var sections = cart && cart.getSectionsToRender && cart.renderContents ? cart.getSectionsToRender() : null;
    var body = {
      items: [{ id: Number(form.dataset.variant), quantity: 1, selling_plan: Number(plan.value), properties: properties }],
    };
    if (sections) {
      body.sections = sections.map(function (section) { return section.id; }).join(',');
      body.sections_url = window.location.pathname;
    }
    button.disabled = true;
    fetch(window.Shopify.routes.root + 'cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data.description || data.message || '');
          return data;
        });
      })
      .then(function (data) {
        if (sections) cart.renderContents(data);
        else say(form.dataset.added, form.dataset.viewCart);
      })
      .catch(function (error) {
        say(error.message || form.dataset.error);
      })
      .finally(function () {
        button.disabled = false;
      });
  });
});
