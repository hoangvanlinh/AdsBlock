// Extension-page feedback for settings controlled by the background.
(function () {
  let errorBox;
  function report(error) {
    if (!errorBox) {
      errorBox = document.createElement('p');
      errorBox.setAttribute('role', 'alert');
      errorBox.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;padding:12px;border-radius:8px;background:#7f1d1d;color:white;font:14px/1.5 sans-serif;white-space:pre-wrap';
      document.body.appendChild(errorBox);
    }
    errorBox.hidden = !error;
    errorBox.textContent = error ? (EXT.i18n.getMessage('settings_updateFailed') || 'Could not apply the change. Please try again.') : '';
    if (error) console.error('[AdBlock] Settings update failed', error);
  }
  async function send(message) {
    const result = await EXT.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Background did not confirm the change');
    return result;
  }
  async function run(control, action, refresh) {
    control.disabled = true;
    report(null);
    try { await action(); }
    catch (error) { report(error); }
    finally {
      try { await refresh(); } catch (error) { report(error); }
      control.disabled = false;
    }
  }
  self.SettingsUI = { send, run };
})();
