/** Google authorization-code broker. Secrets stay in Script properties, not
 * installed apps. Add as a second file alongside Code.gs and redeploy. */
function setupHowladerGoogleLogin() {
  var props = PropertiesService.getScriptProperties();
  var owner = Session.getEffectiveUser().getEmail().toLowerCase();
  var shops = JSON.parse(props.getProperty('HB_SHOPS') || '[]');
  if (!owner || !shops.length) throw new Error('Run setupHowladerSync as the project owner first.');
  var access = JSON.parse(props.getProperty('HB_LOGIN_EMAILS') || '{}');
  if (!access[owner]) access[owner] = shops[0].id;
  props.setProperty('HB_LOGIN_EMAILS', JSON.stringify(access));
  props.setProperty('HB_LOGIN_OWNER_EMAIL', owner);
  var url = props.getProperty('HB_DEPLOYMENT_URL');
  if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw new Error('Set HB_DEPLOYMENT_URL to the deployed /exec URL.');
  if (!props.getProperty('HB_GOOGLE_CLIENT_ID') || !props.getProperty('HB_GOOGLE_CLIENT_SECRET')) throw new Error('Set HB_GOOGLE_CLIENT_ID and HB_GOOGLE_CLIENT_SECRET privately in Script properties.');
  console.log('Google login redirect URI: ' + url + '/oauth/callback');
  console.log('Owner is mapped to the first shop. Other approved emails must be mapped to their shop IDs in HB_LOGIN_EMAILS.');
}
/** Owner-only editor helper. Prints shop IDs, never tokens, keys or secrets. */
function showHowladerLoginShops() {
  var shops = JSON.parse(PropertiesService.getScriptProperties().getProperty('HB_SHOPS') || '[]');
  shops.forEach(function(shop) { console.log(shop.name + ': ' + shop.id); });
}
function hbLoginPost_(input) {
  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  if (input.op === 'loginStart') {
    if (!props.getProperty('HB_GOOGLE_CLIENT_ID') || !props.getProperty('HB_GOOGLE_CLIENT_SECRET') || !props.getProperty('HB_DEPLOYMENT_URL')) hbFail_('LOGIN_NOT_CONFIGURED', 'The owner must configure Google Sign-in first.');
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.challenge || '') || !/^[a-f0-9]{64}$/.test(input.proposedShopKey || '') || typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 80 || !/^[a-zA-Z0-9-]{16,80}$/.test(input.deviceId || '')) hbFail_('BAD_REQUEST', 'Invalid login request.');
    if (cache.get('HB_LOGIN_' + input.requestId)) hbFail_('LOGIN_EXISTS', 'Start a new sign-in request.');
    var state = hbHash_(Utilities.getUuid() + Utilities.getUuid());
    var verifier = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var entry = { requestId: input.requestId, challenge: input.challenge, proposedShopKey: input.proposedShopKey, deviceId: input.deviceId, deviceName: input.deviceName.trim(), state: state, verifier: verifier, expiresAt: Date.now() + 600000 };
    cache.put('HB_LOGIN_' + input.requestId, JSON.stringify(entry), 600);
    cache.put('HB_LOGIN_STATE_' + state, input.requestId, 600);
    var parameters = { client_id: props.getProperty('HB_GOOGLE_CLIENT_ID'), redirect_uri: props.getProperty('HB_DEPLOYMENT_URL') + '/oauth/callback', response_type: 'code', scope: 'openid email profile', prompt: 'select_account', state: state, code_challenge_method: 'S256', code_challenge: Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier, Utilities.Charset.UTF_8)).replace(/=+$/, '') };
    return hbJson_({ ok: true, data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + hbForm_(parameters), expiresAt: entry.expiresAt } });
  }
  if (typeof input.requestId !== 'string' || typeof input.verifier !== 'string' || !/^[a-f0-9]{64}$/.test(input.verifier)) hbFail_('BAD_REQUEST', 'Invalid login proof.');
  var stored = cache.get('HB_LOGIN_' + input.requestId);
  if (!stored) hbFail_('LOGIN_EXPIRED', 'Sign-in expired; start again.');
  var pending = JSON.parse(stored);
  if (pending.expiresAt < Date.now() || !hbEqual_(hbHash_(input.verifier), pending.challenge)) hbFail_('ACCESS_DENIED', 'Invalid or expired sign-in proof.');
  if (input.op === 'loginAck') {
    if (!pending.grant) hbFail_('LOGIN_PENDING', 'Google sign-in is not complete.');
    cache.remove('HB_LOGIN_' + input.requestId);
    return hbJson_({ ok: true, data: { acknowledged: true } });
  }
  if (pending.error) hbFail_(pending.error, 'Google sign-in was not approved for this shop.');
  return hbJson_({ ok: true, data: pending.grant ? { status: 'complete', grant: pending.grant } : { status: 'pending' } });
}
function hbGoogleCallback_(event) {
  var cache = CacheService.getScriptCache();
  var props = PropertiesService.getScriptProperties();
  var params = event && event.parameter || {};
  var requestId = typeof params.state === 'string' ? cache.get('HB_LOGIN_STATE_' + params.state) : null;
  var stored = requestId ? cache.get('HB_LOGIN_' + requestId) : null;
  if (!stored) return hbLoginPage_(false);
  var pending = JSON.parse(stored);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return hbLoginPage_(false);
  try {
    if (cache.get('HB_LOGIN_STATE_' + params.state) !== requestId) return hbLoginPage_(false);
    cache.remove('HB_LOGIN_STATE_' + params.state);
    if (pending.expiresAt < Date.now() || params.error || typeof params.code !== 'string' || !params.code) hbFail_('LOGIN_DENIED', 'Google sign-in was not completed.');
    var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', followRedirects: false, muteHttpExceptions: true, payload: { code: params.code, code_verifier: pending.verifier, client_id: props.getProperty('HB_GOOGLE_CLIENT_ID'), client_secret: props.getProperty('HB_GOOGLE_CLIENT_SECRET'), grant_type: 'authorization_code', redirect_uri: props.getProperty('HB_DEPLOYMENT_URL') + '/oauth/callback' } });
    if (response.getResponseCode() !== 200) hbFail_('LOGIN_DENIED', 'Google code exchange failed.');
    var token = JSON.parse(response.getContentText());
    if (typeof token.access_token !== 'string' || !token.access_token) hbFail_('LOGIN_DENIED', 'Missing Google authorization.');
    // Identity is fetched from Google's HTTPS userinfo endpoint using ONLY the
    // token from this project's own code+PKCE+client-secret exchange. A client
    // cannot submit an email, decoded JWT or arbitrary access token as identity.
    var profileResponse = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token }, followRedirects: false, muteHttpExceptions: true });
    if (profileResponse.getResponseCode() !== 200) hbFail_('LOGIN_DENIED', 'Google identity could not be verified.');
    var identity = JSON.parse(profileResponse.getContentText());
    if (identity.email_verified !== true || typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 255 || typeof identity.email !== 'string') hbFail_('LOGIN_DENIED', 'A verified Google email is required.');
    var email = identity.email.toLowerCase();
    var access = JSON.parse(props.getProperty('HB_LOGIN_EMAILS') || '{}');
    var subjectKey = 'HB_USER_' + hbHash_(identity.sub);
    var bound = props.getProperty(subjectKey);
    var user = bound ? JSON.parse(bound) : null;
    var shopId = access[email];
    if (typeof shopId !== 'string' || (user && user.shopId !== shopId)) hbFail_('ACCESS_DENIED', 'Email is not approved for this shop.');
    var emailKey = 'HB_EMAIL_SUB_' + hbHash_(email);
    if (props.getProperty(emailKey) && props.getProperty(emailKey) !== identity.sub) hbFail_('ACCESS_DENIED', 'Email identity changed; owner review is required.');
    var shop = JSON.parse(props.getProperty('HB_SHOPS') || '[]').filter(function (entry) { return entry.id === shopId; })[0];
    if (!shop) hbFail_('ACCESS_DENIED', 'Shop is unavailable.');
    var shopKey = props.getProperty('HB_SHOP_KEY_' + shopId);
    if (!shopKey) {
      var head = JSON.parse(props.getProperty('HB_HEAD_' + shopId) || 'null');
      if (head && head.revision > 0) hbFail_('KEY_RECOVERY_REQUIRED', 'An existing encrypted database needs its original key.');
      shopKey = pending.proposedShopKey;
      props.setProperty('HB_SHOP_KEY_' + shopId, shopKey);
    }
    var tokenValue = hbHash_(Utilities.getUuid() + Utilities.getUuid() + identity.sub);
    var expiresAt = Date.now() + 30 * 86400000;
    var indexKey = 'HB_USER_DEVICE_' + hbHash_(identity.sub + ':' + pending.deviceId);
    var oldHash = props.getProperty(indexKey);
    if (oldHash) props.deleteProperty('HB_DEVICE_' + oldHash);
    var device = { id: pending.deviceId, shopId: shopId, name: pending.deviceName, userId: identity.sub, email: email, active: true, expiresAt: expiresAt };
    var hash = hbHash_(tokenValue);
    props.setProperty('HB_DEVICE_' + hash, JSON.stringify(device));
    props.setProperty(indexKey, hash);
    props.setProperty(subjectKey, JSON.stringify({ sub: identity.sub, email: email, shopId: shopId }));
    props.setProperty(emailKey, identity.sub);
    pending.grant = { pairing: { protocol: HB_PROTOCOL, serviceId: props.getProperty('HB_SERVICE_ID'), shopId: shopId, shopName: shop.name, deviceId: device.id, deviceName: device.name, token: tokenValue }, shopKey: shopKey, user: { id: identity.sub, email: email, name: typeof identity.name === 'string' ? identity.name : email, shop: { id: shopId, name: shop.name, branchName: shop.name } }, expiresAt: expiresAt };
    delete pending.verifier; delete pending.proposedShopKey;
    cache.put('HB_LOGIN_' + requestId, JSON.stringify(pending), Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)));
    return hbLoginPage_(true);
  } catch (error) {
    pending.error = error && error.hbCode || 'LOGIN_DENIED';
    delete pending.verifier; delete pending.proposedShopKey;
    cache.put('HB_LOGIN_' + requestId, JSON.stringify(pending), 300);
    return hbLoginPage_(false);
  } finally { lock.releaseLock(); }
}
function hbForm_(values) { return Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]); }).join('&'); }
function hbLoginPage_(success) {
  return HtmlService.createHtmlOutput('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Howlader ERP</title></head><body style="font:16px system-ui;padding:32px;max-width:520px;margin:auto"><h2>Howlader ERP</h2><p>' + (success ? 'Google sign-in complete. Return to the Howlader app to finish connecting this device.' : 'Sign-in could not complete. Return to the app and try again, or ask the owner to check account access.') + '</p></body></html>');
}
