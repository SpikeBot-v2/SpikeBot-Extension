// content.js (opt_inハッシュからトークンを拾って送る版)
(async () => {
  if (window.hasRun) return;
  window.hasRun = true;

  // URLフラグメントからトークンを取得（例: #access_token=...&id_token=...）
  const hash = window.location.hash || '';
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');

  console.log('[V5 ContentScript] Trigger finalize. Has access_token?', !!accessToken);

  // background.js に最終処理を依頼（可能ならトークンも一緒に渡す）
  chrome.runtime.sendMessage({
    type: "TRIGGER_FINALIZE",
    access_token: accessToken || null,
    id_token: idToken || null
  });
})();