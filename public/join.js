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

/* ==========================================================================
   JOIN FLYER — a continuously floating list of "who joined" messages.
   Names + messages are built once into a track that's duplicated exactly
   once, then a pure CSS animation floats it top-to-bottom on an endless,
   seamless loop (no JS-driven interval swapping — genuinely continuous
   motion instead of a discrete "snap" every few seconds).
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  const list = document.getElementById('flyerList');
  if (!list) return;

  const names = [
    // men
    'Muhammad Ali', 'Ahmed Raza', 'Bilal Khan', 'Usman Tariq',
    'Hassan Mahmood', 'Abdullah Sheikh', 'Fahad Iqbal', 'Imran Qureshi',
    'Junaid Akhtar', 'Kamran Shahid', 'Saad Anwar', 'Talha Malik',
    'Zeeshan Ahmed', 'Ahsan Raza', 'Hamza Tariq', 'Noman Aslam',
    'Adnan Khan', 'Farhan Ahmed', 'Sufyan Mahmood', 'Daniyal Khan',
    'Asad Ullah', 'Bilal Ahmed', 'Faisal Mehmood', 'Gohar Ali',
    'Haris Nadeem', 'Irfan Malik', 'Jibran Sheikh', 'Khurram Raza',
    'Mansoor Ahmed', 'Naveed Iqbal', 'Omer Sheikh', 'Prem Gull',
    'Qasim Raza', 'Raheel Khan', 'Salman Tariq', 'Tahir Mehmood',
    'Umair Javed', 'Waqar Younis', 'Yasir Hussain', 'Zain Abbas',
    'Sameer Baig', 'Rizwan Yousaf', 'Danish Ali', 'Waleed Farooq',
    'Ammar Siddiqui', 'Shahzaib Khan', 'Moiz Ansari', 'Taimoor Chaudhry',
    'Rehan Bhatti', 'Arsalan Javed', 'Zohaib Iqbal', 'Nabeel Aziz',
    'Owais Mirza', 'Hamdan Riaz', 'Ibrahim Sultan', 'Shayan Wasti',
    'Mustafa Durrani', 'Ayaan Cheema', 'Bakht Zaman', 'Sohail Butt',
    // women
    'Ayesha Malik', 'Sara Khan', 'Fatima Zahra', 'Zainab Fatima',
    'Mahnoor Aslam', 'Hira Sheikh', 'Amna Tariq', 'Sana Riaz',
    'Iqra Yousaf', 'Mariam Chaudhry', 'Noor Fatima', 'Rabia Khan',
    'Sadia Iqbal', 'Kiran Malik', 'Bushra Ahmed', 'Warda Sheikh',
    'Anum Raza', 'Komal Butt', 'Areeba Khan', 'Nimra Javed',
  ];

  const messages = [
    (n) => `${n} just joined`,
    (n) => `${n} just bought the membership`,
    (n) => `${n} just joined the Barça Family`,
  ];

  // Fisher-Yates shuffle so the order feels different on every page load
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Build a decent-length list (24 entries) so the loop doesn't feel repetitive
  const shuffled = shuffle(names).slice(0, 24);
  const lines = shuffled.map((name) => {
    const template = messages[Math.floor(Math.random() * messages.length)];
    return template(name);
  });

  const rowsHTML = lines.map((text) => `<li class="flyer-row">${text}</li>`).join('');
  // Render the list TWICE back-to-back — that's what makes the CSS
  // animation's translateY(-50%) → translateY(0%) loop seamlessly forever.
  list.innerHTML = rowsHTML + rowsHTML;
});
