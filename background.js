// background.js (司令塔としての最終完成版)

const WORKER_DOMAIN = 'spikebot-v2-worker.halkun19.workers.dev';
const AUTH_START_URL = `https://${WORKER_DOMAIN}/auth`;

// --- フロー1: Discordからの最初のクリックを検知 (変更なし) ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.startsWith(AUTH_START_URL)) {
    try {
      const url = new URL(changeInfo.url);
      const stateToken = url.searchParams.get('state');
      if (!stateToken) return;

      console.log('[V5.1 Background] Auth process started. Saving state token:', stateToken);
      await clearFinalizeFlag();
      await chrome.storage.local.set({ valorantAuthState: { state_token: stateToken } });
      
      const riotAuthUrl = 'https://auth.riotgames.com/authorize' +
        '?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in' +
        '&client_id=play-valorant-web-prod' +
        '&response_type=token%20id_token' +
        '&nonce=1' +
        '&scope=account%20openid';
      
      await chrome.tabs.update(tabId, { url: riotAuthUrl });
    } catch (error) {
      console.error('[V5.1 Background] Error in initial auth step:', error);
    }
  }
});

// ★★★ ここからが究極の解決策 ★★★
async function getCookiesWithRetry(retries = 12, delay = 1500) {
  // いくつかのドメイン/パーティションに分散してクッキーが作成されるケースに対応（ChromeのPartitioned Cookies対策）
  const domains = [
    'auth.riotgames.com',
    '.riotgames.com',
    'riotgames.com',
    '.playvalorant.com',
    'playvalorant.com',
  ];
  const topLevelSites = [
    'https://playvalorant.com',
    'https://www.playvalorant.com',
    'https://auth.riotgames.com',
  ];

  for (let i = 0; i < retries; i++) {
    console.log(`[V5.1 Background] Attempting to get cookies across domains/partitions (Attempt ${i + 1}/${retries})...`);

    const calls = [];
    for (const d of domains) {
      // 非パーティション
      calls.push(
        chrome.cookies.getAll({ domain: d }).then(cs => cs).catch(() => [])
      );
      // パーティション（Top-level site ごと）
      for (const site of topLevelSites) {
        calls.push(
          chrome.cookies.getAll({ domain: d, partitionKey: { topLevelSite: site } })
            .then(cs => cs)
            .catch(() => [])
        );
      }
    }

    const results = await Promise.all(calls);
    const allCookies = results.flat();

    // 名前ごとに優先度で統合（auth.riotgames.com を最優先、その次に partitioned のもの）
    const byName = new Map();
    function score(c) {
      let s = 0;
      if (c.domain === 'auth.riotgames.com') s += 2;
      if (c.partitionKey && (c.partitionKey.topLevelSite || c.partitionKey.site)) s += 1;
      return s;
    }

    for (const c of allCookies) {
      const existing = byName.get(c.name);
      if (!existing || score(c) > score(existing)) {
        byName.set(c.name, c);
      }
    }

    const cookies = Array.from(byName.values());
    const hasSsid = byName.has('ssid');

    // 新規ログイン直後は ssid の存在を最優先で判定（clid/tdid は遅延・パーティションで見えない場合がある）
    if (cookies.length > 0 && hasSsid) {
      console.log('[V5.1 Background] Found required cookies (ssid present).', {
        count: cookies.length,
        partitioned: cookies.some(c => !!c.partitionKey),
      });
      return cookies;
    }

    console.log(`[V5.1 Background] Essential cookies not ready yet. Waiting ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`Could not find valid Riot Games cookies after ${retries} attempts.`);
}
// ★★★ ここまでが究極の解決策 ★★★

/**
 * Finalize guard helpers to avoid double submit between webNavigation and content message.
 */
async function isFinalized() {
  const flag = await chrome.storage.local.get('valorantAuthFinalized');
  return !!(flag && flag.valorantAuthFinalized);
}

async function markFinalized() {
  await chrome.storage.local.set({ valorantAuthFinalized: true });
}

async function clearFinalizeFlag() {
  await chrome.storage.local.remove('valorantAuthFinalized');
}

// --- フロー2: Content.jsからの合図を待機 ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRIGGER_FINALIZE") {
    (async () => {
      try {
        console.log('[V5.1 Background] Finalize triggered. Processing...');

        // Guard to prevent double finalize
        if (await isFinalized()) {
          console.warn('[V5.1 Background] Already finalized. Skipping TRIGGER_FINALIZE.');
          return;
        }
        
        const data = await chrome.storage.local.get('valorantAuthState');
        if (!data?.valorantAuthState?.state_token) throw new Error('State token not found.');
        const stateToken = data.valorantAuthState.state_token;
        await chrome.storage.local.remove('valorantAuthState');

        // ★★★ 変更: access_token があれば優先送信。無ければクッキーでフォールバック ★★★
        const payload = { state_token: stateToken };

        if (message.access_token) {
          payload.access_token = message.access_token;
          if (message.id_token) payload.id_token = message.id_token;
          console.log('[V5.1 Background] Using access_token from redirect hash.');
          // 可能であればCookieも添付して永続運用に備える
          try {
            const cookies = await getCookiesWithRetry();
            const cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            payload.cookies_str = cookiesStr;
            console.log('[V5.1 Background] Also attached cookies with access_token.');
          } catch (e) {
            console.warn('[V5.1 Background] Could not fetch cookies alongside token (will proceed with token only).', e);
          }
        } else {
          try {
            const cookies = await getCookiesWithRetry();
            const cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            payload.cookies_str = cookiesStr;
            console.log('[V5.1 Background] Using cookies fallback.');
          } catch (e) {
            console.warn('[V5.1 Background] Could not obtain cookies and no access_token present.', e);
          }
        }

        const response = await fetch(`https://${WORKER_DOMAIN}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) throw new Error(`Worker responded with status: ${response.status}`);
        
        const successHtml = await response.text();

        // Mark finalized to avoid subsequent handler from running
        await markFinalized();
        
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          func: (htmlContent) => { document.documentElement.innerHTML = htmlContent; },
          args: [successHtml]
        });
        console.log('[V5.1 Background] Successfully replaced page content.');

      } catch (error) {
        console.error('[V5.1 Background] Failed to finalize:', error);
        // エラーページを表示する処理もここに追加可能
      }
    })();
    return true;
  }
});

// --- フロー3: /opt_in への最終リダイレクトをwebNavigationで監視し、ハッシュからトークンを直接回収 ---
chrome.webNavigation.onCommitted.addListener(async (details) => {
 try {
   // メインフレームのみ
   if (details.frameId !== 0) return;

   // Guard to prevent double finalize
   if (await isFinalized()) {
     console.warn('[V5.1 Background] webNavigation: Already finalized. Skipping.');
     return;
   }

    const urlStr = details.url || '';
    // playvalorant.com 配下の opt_in で発火（ロケール付きにも対応）
    if (!/^https:\/\/([a-z-]+\.)?playvalorant\.com\/.*\/?opt_in/i.test(urlStr) &&
        !/^https:\/\/playvalorant\.com\/opt_in/i.test(urlStr)) {
      return;
    }

    const u = new URL(urlStr);
    const hash = u.hash || '';
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const accessToken = params.get('access_token');
    const idToken = params.get('id_token');

    const data = await chrome.storage.local.get('valorantAuthState');
    if (!data?.valorantAuthState?.state_token) {
      console.warn('[V5.1 Background] No state token in storage on webNavigation finalize.');
      return;
    }
    const stateToken = data.valorantAuthState.state_token;
    await chrome.storage.local.remove('valorantAuthState');
    // Mark finalized early to prevent race with TRIGGER_FINALIZE listener
    await markFinalized();

    const payload = { state_token: stateToken };
    if (accessToken) {
      payload.access_token = accessToken;
      if (idToken) payload.id_token = idToken;
      console.log('[V5.1 Background] webNavigation: Using access_token from URL hash.');
      // 可能であればCookieも添付して永続運用に備える
      try {
        const cookies = await getCookiesWithRetry();
        const cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        payload.cookies_str = cookiesStr;
        console.log('[V5.1 Background] webNavigation: Also attached cookies with access_token.');
      } catch (e) {
        console.warn('[V5.1 Background] webNavigation: Could not fetch cookies alongside token (proceeding with token only).', e);
      }
    } else {
      try {
        const cookies = await getCookiesWithRetry();
        const cookiesStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        payload.cookies_str = cookiesStr;
        console.log('[V5.1 Background] webNavigation: Using cookies fallback.');
      } catch (e) {
        console.warn('[V5.1 Background] webNavigation: Neither tokens nor cookies available.', e);
      }
    }

    const response = await fetch(`https://${WORKER_DOMAIN}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`Worker responded with status: ${response.status}`);

    const successHtml = await response.text();

    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: (htmlContent) => { document.documentElement.innerHTML = htmlContent; },
      args: [successHtml]
    });
    console.log('[V5.1 Background] webNavigation: Successfully replaced page content.');
  } catch (e) {
    console.error('[V5.1 Background] webNavigation finalize failed:', e);
  }
}, { url: [{ hostSuffix: 'playvalorant.com' }] });