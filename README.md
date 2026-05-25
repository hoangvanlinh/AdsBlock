<p align="center">
  <img src="icons/icon128.png" width="80" height="80" alt="AdBlock logo">
</p>

<h1 align="center">AdBlock — Ads, Trackers</h1>

<p align="center">
  A fast, privacy-first browser extension that blocks ads, trackers, and malware.<br>
  Available for Chrome, Firefox, and Edge — lightweight, open source, no data collection.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="https://prostores.top/">Website</a> •
  <a href="#install">Install</a> •
  <a href="#build">Build</a> •
  <a href="#project-structure">Structure</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#donate">Donate</a>
</p>

<p align="center">
  Project website: <a href="https://prostores.top/">prostores.top</a>
</p>

<p align="center">
  Available for full project work: frontend, backend, and end-to-end product development.
</p>

---

## Features

- **Ad Blocking** — Blocks ad requests via `declarativeNetRequest` (Google Ads, DFP, Outbrain, Taboola, Amazon Ads, Criteo, and more)
- **Tracker Blocking** — Stops tracking scripts from Google Analytics, Hotjar, Mixpanel, Amplitude, and more
- **Malware Protection** — Blocks known malicious domains (cryptominers, phishing) with auto-updating blocklists
- **Cosmetic Filtering** — Hides ad elements in the DOM via CSS + JS with minimal impact on page layout
- **YouTube Ad Skipper** — Automatically mutes and fast-forwards pre-roll/mid-roll video ads
- **Multi-Site Native Ad Blocking** — Uses one generic blocker plus site rules for YouTube cosmetic ads, Facebook, Reddit, Instagram, TikTok, X/Twitter, LinkedIn, Pinterest, Quora, Amazon, Google Search, VnExpress, and Tuổi Trẻ
- **Focus Mode** — Block distracting sites with a built-in Pomodoro timer
- **Privacy Score** — Privacy rating based on ads blocked, trackers blocked, malware, and referrer protection
- **Per-Site Controls** — Pause blocking on specific sites, manage allowlists
- **Custom Rules** — Add your own domain/keyword/CSS/regex blocking rules
- **Dashboard** — Glassmorphism dark UI with daily stats, charts, domain breakdown, and settings
- **Zero Data Collection** — All data stays local in `chrome.storage.local`

## Install

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/hoangvanlinh/AdsBlock.git
   cd AdsBlock
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the cloned folder

5. The extension icon will appear in your toolbar — you're ready to go!

### From a browser store

Available on Chrome, Firefox, and Edge:

<p align="center">
  <a href="https://chromewebstore.google.com/detail/adblock-%E2%80%94-ads-trackers/emdofgiggmkkncojffpebiaegdmdkgio">
    <img src="https://img.shields.io/badge/Chrome-Get%20Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install from Chrome Web Store">
  </a>
  &nbsp;
  <a href="https://addons.mozilla.org/addon/adblock-ads-trackers/">
    <img src="https://img.shields.io/badge/Firefox-Get%20Extension-FF7139?style=for-the-badge&logo=firefox&logoColor=white" alt="Install from Firefox Add-ons">
  </a>
  &nbsp;
  <a href="#install">
    <img src="https://img.shields.io/badge/Edge-Get%20Extension-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white" alt="Install from Microsoft Edge Add-ons">
  </a>
</p>

## Build

```bash
# Build a single target (with obfuscation by default)
./build-chrome.sh          # → dist/  +  adblock-extension.zip
./build-firefox.sh         # → dist-firefox/  +  adblock-extension-firefox.zip
./build-edge.sh            # → dist-edge/  +  adblock-extension-edge.zip

# Or use the orchestrator
./build.sh chrome          # Chrome only
./build.sh firefox         # Firefox only
./build.sh edge            # Edge only
./build.sh all             # All three targets
```

**Arguments** (same for all scripts):

| # | Name | Default | Description |
|---|------|---------|-------------|
| 1 | `target` | `chrome` | `chrome` \| `firefox` \| `edge` \| `all` *(orchestrator only)* |
| 2 | `obfuscate` | `true` | Obfuscate JS with `javascript-obfuscator` |
| 3 | `export_obfuscated_src` | `false` | Export obfuscated source tree to `src-obfuscated[-target]/` |
| 4 | `debug` | `false` | Patch `DEBUG_LOCAL=true` in the rules loader (loads local file instead of remote) |

```bash
# Examples
./build.sh all false               # All targets, no obfuscation
./build.sh all false false true    # All targets, no obfuscation, DEBUG_LOCAL=true
./build-chrome.sh true true        # Chrome, obfuscated + export source tree
```

## Project Structure

```
ablock/
├── manifest.json             # Extension manifest (MV3, Chrome)
├── manifest.firefox.json     # Extension manifest (Firefox)
├── background.js             # Service worker — DNR rules, stats, malware lists, alarms
├── build.sh                  # Build script (packages dist for Chrome & Firefox)
├── content/
│   ├── content.js            # Content script — cosmetic engine, injects scriptlets into MAIN world
│   ├── content.css           # Cosmetic filter CSS rules (scoped to html.adblock-on)
│   ├── scriptlets.js         # MAIN-world scriptlets — API proxies, popup blockers, navigation guards
│   ├── site-rules-loader.js  # Shared parser for remote/local text-based site rules
│   └── site-block.js         # Generic native ad blocker driven by site rules
├── rule/
│   └── site-rules.txt        # Local fallback for the remote rule map
├── popup/
│   ├── popup.html            # Browser action popup UI
│   ├── popup.js              # Popup logic — toggle, stats, pause, focus mode
│   └── popup.css             # Popup styles (glassmorphism dark theme)
├── dashboard/
│   ├── dashboard.html        # Full-page dashboard / options page
│   ├── dashboard.js          # Dashboard logic — charts, rules, allowlist, settings
│   └── dashboard.css         # Dashboard styles
└── icons/                    # Extension icons (16/48/128, on/off states)
```

## How It Works

### Network Blocking

Uses Chrome's `declarativeNetRequest` API to block ad/tracker/malware requests at the network level before they reach the page. Rules target known ad domains (doubleclick.net, googlesyndication.com, etc.) and tracker endpoints.

### Cosmetic Filtering

Injects CSS (`content.css`) and JS (`content.js`) at `document_start` to hide ad elements in the DOM. All selectors are scoped to `html.adblock-on` so toggling protection is instant without a page reload. A `MutationObserver` watches for dynamically injected ad elements (SPA pages, infinite scroll).

`content.js` also injects `scriptlets.js` into the **MAIN world** — the same JavaScript context as page scripts — so scriptlets can proxy native browser APIs (`window.open`, `EventTarget.prototype.addEventListener`, `Location.prototype.href`, etc.) before any ad script runs.

### YouTube Ad Blocking

YouTube video ads share the same domain as real videos, so network blocking can't catch them. Instead, the extension strips ad data at the API level:

- `scriptlets.js` intercepts `fetch()` and `XMLHttpRequest` responses and prunes `adPlacements`, `adSlots`, and `playerAds` fields from player JSON before the player reads them.
- `setConstant` freezes `ytInitialPlayerResponse.playerAds`, `adPlacements`, and `adSlots` to `undefined` in the inline page script.
- `rule/site-rules.txt` provides cosmetic selectors to hide feed and sidebar ad surfaces.

### Multi-Site Native Ad Blocking

The extension uses one generic site blocker driven by `rule/site-rules.txt` for YouTube cosmetic surfaces, Facebook, Reddit, Instagram, TikTok, X/Twitter, LinkedIn, Pinterest, Quora, Amazon, Google Search, VnExpress, and Tuổi Trẻ. Site-specific behavior comes from rule sections like labels, selectors, direct-hide selectors, context selectors, ad host selectors, link patterns, and closest-hide targets.

Ad network coverage also includes major mobile ad SDKs: Xiaomi, Samsung, Apple iAd, Unity Ads, OPPO/Realme, TikTok Ads, Yandex, and others — blocking their request endpoints via `declarativeNetRequest`.

### Editable Site Rules

The generic site blocker loads labels, selectors, and link patterns from the remote rule URL first, with `rule/site-rules.txt` as a local fallback through a shared loader. The shared content engine reads global defaults from that file for cosmetic selectors, ad script hosts, and classifier patterns. You can tune blocker heuristics by editing that file or updating the remote rule source.

Remote community malware blocklists (URLhaus, Phishing Army) are filtered using the **exact domain** from each entry — subdomains like `sub.example.com` are blocked precisely without over-blocking the root `example.com` or sibling domains.



### Focus Mode

Blocks configurable distraction domains (social media, etc.) with a countdown timer. Integrates with both the popup and the full dashboard.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings, stats, and rules locally |
| `declarativeNetRequest` | Block network requests (ads, trackers, malware) |
| `alarms` | Periodic malware list updates |
| `http://*/*`, `https://*/*` | Content script injection on all pages |

## Contributing

Contributions are welcome! For questions, bug reports, or project inquiries, reach out at **hoangvanlinh421@gmail.com**.

Here's how to get started:

1. **Fork** this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and test locally (load unpacked in Chrome)
4. Commit: `git commit -m "Add my feature"`
5. Push: `git push origin feature/my-feature`
6. Open a **Pull Request**

### Guidelines

- Keep changes focused — one feature or fix per PR
- Test on YouTube and a few general sites before submitting
- Don't add broad CSS wildcard selectors (e.g. `[class*="ad"]`) — they cause false positives
- All blocking logic should be scoped so it can be toggled per-site

## License

This project is open source under the [MIT License](LICENSE).

---

## Donate

If this extension saves you time and makes your browsing better, consider buying me a coffee! Every bit helps keep the project maintained and ad-free (ironically).

<p align="center">
  <a href="https://www.paypal.me/linhhvtt/5">
    <img src="https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge&logo=paypal" alt="Donate with PayPal">
  </a>
</p>

<p align="center">
  <a href="https://www.paypal.me/linhhvtt/5"><strong>paypal.me/linhhvtt</strong></a>
</p>

---

<p align="center">
  Made with ❤️ for a cleaner, faster, more private web.
</p>
