document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('joinForm');
  if (!form) return;

  const childCheckbox = document.getElementById('child');
  const childRow = document.getElementById('childRow');
  const membershipSelect = document.getElementById('membershipType');
  const submitBtn = document.getElementById('joinSubmitBtn');
  const messageBox = document.getElementById('formMessage');

  childCheckbox.addEventListener('change', () => {
    childRow.style.display = childCheckbox.checked ? 'grid' : 'none';
    if (childCheckbox.checked) membershipSelect.value = 'kids';
  });

  // Pull live prices from the server so this page never shows a stale amount
  // even if an admin changed pricing five minutes ago.
  fetch('/api/pricing')
    .then((r) => r.json())
    .then((pricing) => {
      const fmt = (n) => `${pricing.currency} ${Number(n).toLocaleString()}`;
      document.getElementById('feeAdultPrice').textContent = fmt(pricing.adult);
      document.getElementById('feeKidsPrice').textContent = fmt(pricing.kids);
      document.getElementById('priceAdultLabel').textContent = fmt(pricing.adult);
      document.getElementById('priceKidsLabel').textContent = fmt(pricing.kids);
    })
    .catch(() => {
      // fall back silently to the static prices already in the HTML
    });

  // "Pay Now" on a fee card scrolls to the form and preselects that membership type
  document.querySelectorAll('.fee-card a[data-type]').forEach((link) => {
    link.addEventListener('click', () => {
      membershipSelect.value = link.dataset.type;
      if (link.dataset.type === 'kids') {
        childCheckbox.checked = true;
        childRow.style.display = 'grid';
      }
    });
  });

  function showMessage(text, kind) {
    messageBox.style.display = 'block';
    messageBox.textContent = text;
    messageBox.style.background = kind === 'error' ? 'rgba(165,0,68,.1)' : 'rgba(0,77,152,.1)';
    messageBox.style.color = kind === 'error' ? '#A50044' : '#004D98';
    messageBox.style.border = `1px solid ${kind === 'error' ? '#A50044' : '#004D98'}`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showMessage('', 'info');
    messageBox.style.display = 'none';

    const agreeBox = document.getElementById('agree');
    if (!agreeBox.checked) {
      showMessage('Please agree to the Statutes and Privacy Notice to continue.', 'error');
      return;
    }

    const fd = new FormData(form);
    const payload = {
      firstName: fd.get('firstName'),
      lastName: fd.get('lastName'),
      contactNumber: fd.get('contactNumber'),
      country: fd.get('country'),
      email: fd.get('email'),
      membershipType: fd.get('membershipType'),
      childName: fd.get('childName'),
      childDob: fd.get('childDob'),
      agreedToStatutes: agreeBox.checked,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait…';

    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        showMessage(data.error || 'Something went wrong. Please check the form and try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue to Payment';
        return;
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl; // hand off to Stripe Checkout
        return;
      }

      // Saved, but payment couldn't be started (e.g. Stripe not configured yet)
      showMessage(data.warning || 'Your submission was received.', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue to Payment';
    } catch (err) {
      showMessage('Network error — please check your connection and try again.', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue to Payment';
    }
  });
});
