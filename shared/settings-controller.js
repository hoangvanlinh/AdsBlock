// Serializes user setting changes and restores the previous state on apply failure.
(function (root) {
  function create({ storage, applyNetworkRules, applyPrivacy, notify, domainPatternRe }) {
    let chain = Promise.resolve();
    const blocking = ['blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware'];
    const privacy = ['referrerAnonymization', 'gpcSignal', 'dntHeader'];
    async function handle(msg) {
      let keys, patch;
      // Re-enabling protection also optionally clears this domain's pause
      // (msg.domain), folded into the SAME storage write + applyNetworkRules()
      // pass instead of the caller sending a second TOGGLE-then-PAUSE_DOMAIN
      // round trip (each of which rebuilds every DNR rule).
      let unpauseDomain = false;
      if (msg.type === 'TOGGLE') {
        if (typeof msg.enabled !== 'boolean') throw new Error('Invalid enabled value');
        keys = ['enabled']; patch = { enabled: msg.enabled };
        if (msg.domain !== undefined) {
          if (typeof msg.domain !== 'string' || !domainPatternRe.test(msg.domain)) throw new Error('Invalid domain');
          keys = ['enabled', 'pausedDomains']; unpauseDomain = true;
        }
      } else if (msg.type === 'PAUSE_DOMAIN') {
        if (typeof msg.paused !== 'boolean' || typeof msg.domain !== 'string' ||
            !domainPatternRe.test(msg.domain)) throw new Error('Invalid domain or pause value');
        keys = ['pausedDomains'];
      } else {
        const allowed = msg.type === 'SET_BLOCKING' ? blocking : msg.type === 'SET_PRIVACY' ? privacy : [];
        if (!allowed.includes(msg.setting) || typeof msg.value !== 'boolean') throw new Error('Invalid setting');
        keys = [msg.setting]; patch = { [msg.setting]: msg.value };
      }
      // Strict reads/writes: an unavailable store must never look like an empty store.
      const previous = await storage.get(keys);
      if (msg.type === 'PAUSE_DOMAIN' || unpauseDomain) {
        const domain = msg.domain.toLowerCase();
        const domains = previous.pausedDomains || [];
        const paused = unpauseDomain ? false : msg.paused;
        const pausedDomains = paused ? [...new Set([...domains, domain])] : domains.filter(d => d !== domain);
        patch = patch ? { ...patch, pausedDomains } : { pausedDomains };
      }
      const apply = async () => {
        const result = msg.type === 'SET_PRIVACY'
          ? await applyPrivacy(msg.setting, (await storage.get(msg.setting))[msg.setting] ?? true)
          : await applyNetworkRules();
        if (result?.ok === false) throw new Error(result.error || 'Could not apply rules');
      };
      await storage.set(patch);
      try {
        await apply();
      } catch (error) {
        try {
          await storage.set(previous);
          const absent = keys.filter(key => !Object.prototype.hasOwnProperty.call(previous, key));
          if (absent.length) await storage.remove(absent);
          await apply();
        } catch (rollbackError) {
          throw new Error(`${error.message}; could not restore previous protection: ${rollbackError.message}`);
        }
        throw error;
      }
      await notify(msg);
      return { ok: true };
    }
    return { handle(msg) {
      const result = chain.catch(() => {}).then(() => handle(msg));
      chain = result;
      return result;
    } };
  }
  root.SettingsController = { create };
  if (typeof module !== 'undefined') module.exports = root.SettingsController;
})(typeof self === 'undefined' ? globalThis : self);
