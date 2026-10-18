(async function () {
  const pill = document.getElementById('sync-pill');
  const meta = document.getElementById('profile-meta');
  const fillBtn = document.getElementById('fill-tab');
  const openLink = document.getElementById('open-site');

  const res = await chrome.runtime.sendMessage({ type: 'GET_MEMBER_STATE_FOR_PAGE' }).catch(() => null);
  const state = res?.state;
  if (res?.auth?.apiOrigin) {
    openLink.href = res.auth.apiOrigin;
  }
  if (state?.profile?.name || state?.resume?.filename) {
    pill.textContent = 'Synced';
    pill.classList.add('ok');
    meta.textContent = `${state.profile?.name || 'Member'} · ${state.resume?.filename || 'CV ready'}`;
  } else {
    pill.textContent = 'Ready';
  }

  fillBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    fillBtn.textContent = 'Filling…';
    const scan = await chrome.tabs.sendMessage(tab.id, {
      type: 'SCAN_AND_FILL_FORM',
      memberState: state || {}
    }).catch(() => null);
    if (scan?.disclosure?.length) {
      fillBtn.textContent = `Filled ${scan.disclosure.length} fields ✓`;
    } else {
      fillBtn.textContent = 'No application fields found';
    }
  });
})();
