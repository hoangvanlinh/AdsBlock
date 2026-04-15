<p align="center">
  <img src="icons/icon128.png" width="80" height="80" alt="AdBlock logo">
</p>

<h1 align="center">AdBlock — Ads, Trackers</h1>

<p align="center">
  A fast, privacy-first Chrome extension that blocks ads, trackers, and malware.<br>
  Built with Manifest V3 — lightweight, open source, no data collection.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#install">Install</a> •
  <a href="#project-structure">Structure</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#donate">Donate</a>
</p>

---

## Features

- **Ad Blocking** — Blocks ad requests via `declarativeNetRequest` (Google Ads, DFP, Outbrain, Taboola, Amazon Ads, Criteo, and more)
- **Tracker Blocking** — Stops tracking scripts from Google Analytics, Hotjar, Mixpanel, Amplitude, and more
- **Malware Protection** — Blocks known malicious domains (cryptominers, phishing) with auto-updating blocklists
- **Cosmetic Filtering** — Hides ad elements in the DOM via CSS + JS without breaking page layouts
- **YouTube Ad Skipper** — Automatically mutes and fast-forwards pre-roll/mid-roll video ads
- **Multi-Site Native Ad Blocking** — Uses one generic blocker plus site rules for YouTube cosmetic ads, Facebook, Reddit, Instagram, TikTok, X/Twitter, LinkedIn, Pinterest, Quora, Amazon, and Google Search ads
- **Focus Mode** — Block distracting sites with a built-in Pomodoro timer
- **Privacy Score** — Real-time privacy rating based on ads, trackers, malware, and referrer protection
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

### From Chrome Web Store

Install directly from the Chrome Web Store:

<p align="center">
  <a href="https://chromewebstore.google.com/detail/adblock-%E2%80%94-ads-trackers/emdofgiggmkkncojffpebiaegdmdkgio">
    <img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install from Chrome Web Store">
  </a>
</p>

## Project Structure

```
ablock/
├── manifest.json           # Extension manifest (MV3, Chrome)
├── manifest.firefox.json   # Extension manifest (Firefox)
├── background.js           # Service worker — DNR rules, stats, malware lists, alarms
├── build.sh                # Build script (packages dist for Chrome & Firefox)
├── content/
│   ├── content.js          # Content script — shared cosmetic engine plus YouTube bootstrap
│   ├── content.css         # Cosmetic filter CSS rules
│   ├── site-rules-loader.js # Shared parser for remote/local text-based site rules
│   ├── site-block.js       # Generic site-specific blocker driven by site rules
│   └── yt-adblock.js       # YouTube anti-adblock and skipper engine (runs in MAIN world)
├── rule/
│   └── site-rules.txt      # Local fallback for the remote rule map
├── popup/
│   ├── popup.html          # Browser action popup UI
│   ├── popup.js            # Popup logic — toggle, stats, pause, focus mode
│   └── popup.css           # Popup styles (glassmorphism dark theme)
├── dashboard/
│   ├── dashboard.html      # Full-page dashboard / options page
│   ├── dashboard.js        # Dashboard logic — charts, rules, allowlist, settings
│   └── dashboard.css       # Dashboard styles
└── icons/                  # Extension icons (16/48/128, on/off states)
```

## How It Works

### Network Blocking

Uses Chrome's `declarativeNetRequest` API to block ad/tracker/malware requests at the network level before they reach the page. Rules target known ad domains (doubleclick.net, googlesyndication.com, etc.) and tracker endpoints.

### Cosmetic Filtering

Injects CSS and JS at `document_start` to hide ad elements in the DOM. All selectors are scoped to `html.adblock-on` so toggling protection is instant without a page reload. A `MutationObserver` watches for dynamically injected ad elements (SPA pages, infinite scroll).

### YouTube Ad Skipper

YouTube video ads share the same domain as real videos, so network blocking can't catch them. Instead, the extension:
1. Detects ads via player class changes (`ad-showing`, `ad-interrupting`)
2. Mutes the ad audio instantly
3. Clicks skip buttons or fast-forwards to the end (`playbackRate = 16`)
4. Hides all ad UI (timer, progress bar, badges) via inline styles
5. Restores normal playback when the ad ends

YouTube uses a hybrid model: `rule/site-rules.txt` provides cosmetic selectors for feed, sidebar, and promo surfaces, while `content/yt-adblock.js` keeps the page-runtime hooks needed for anti-adblock bypass, ad-response stripping, and player recovery.

### Multi-Site Native Ad Blocking

The extension uses one generic site blocker driven by `rule/site-rules.txt` for YouTube cosmetic surfaces, Facebook, Reddit, Instagram, TikTok, X/Twitter, LinkedIn, Pinterest, Quora, Amazon, and Google Search. Site-specific behavior comes from rule sections like labels, selectors, direct-hide selectors, context selectors, ad host selectors, link patterns, and closest-hide targets.

### Editable Site Rules

The generic site blocker now loads labels, selectors, and link patterns from the remote rule URL first, with `rule/site-rules.txt` as a local fallback through a shared loader. The shared content engine also reads global defaults from that file for cosmetic selectors, ad script hosts, and fallback classifier patterns. You can tune many of the blocker heuristics by editing that text file in the repository or by updating the remote rule source.



### Focus Mode

Blocks configurable distraction domains (social media, etc.) with a countdown timer. Integrates with both the popup and the full dashboard.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings, stats, and rules locally |
| `declarativeNetRequest` | Block network requests (ads, trackers, malware) |
| `alarms` | Periodic malware list updates |
| `<all_urls>` | Content script injection on all pages |

## Contributing

Contributions are welcome! Here's how to get started:

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
