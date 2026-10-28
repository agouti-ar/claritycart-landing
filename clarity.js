let savedConfig = {};
try {
    const saved = localStorage.getItem('clarity_user_config');
    if (saved) savedConfig = JSON.parse(saved);
} catch (e) { }

// Read live settings from localStorage (broadcast from dashboard)
const _lsFriendlyTone = localStorage.getItem('clarity_friendly_tone');
const _lsUseEmojis = localStorage.getItem('clarity_use_emojis');
const _lsExitIntent = localStorage.getItem('clarity_exit_intent');

function resolveStoreDomain() {
    // 1. Script tag with data-domain
    const scriptWithDomain = document.querySelector('script[data-domain]');
    if (scriptWithDomain && scriptWithDomain.getAttribute('data-domain')) {
        return scriptWithDomain.getAttribute('data-domain').trim().toLowerCase();
    }
    if (document.currentScript && document.currentScript.getAttribute('data-domain')) {
        return document.currentScript.getAttribute('data-domain').trim().toLowerCase();
    }
    // 2. LocalStorage set by dashboard
    try {
        const ls = localStorage.getItem('clarity_store_domain');
        if (ls && ls !== 'mystore.com' && ls !== 'unknown') return ls.trim().toLowerCase();
    } catch(e) {}
    // 3. Current host if valid domain
    if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        return window.location.hostname.toLowerCase();
    }
    return 'my-super-shoes.com';
}

window.ClarityCartConfig = window.ClarityCartConfig || {
    activeTier: localStorage.getItem('clarity_active_tier') || 'Starter',
    intentDiscountEnabled: savedConfig.intentDiscountEnabled || false,
    promoCode: savedConfig.promoCode || "",
    discountAmount: savedConfig.discountAmount || "",
    whiteLabel: savedConfig.whiteLabel || false,
    tone: savedConfig.tone || "friendly",
    use_emojis: _lsUseEmojis !== null ? (_lsUseEmojis === 'true') : (savedConfig.use_emojis !== false),
    friendly_tone: _lsFriendlyTone !== null ? (_lsFriendlyTone === 'true') : (savedConfig.friendly_tone !== false),
    customTonePrompt: savedConfig.customTonePrompt || "",
    themePreset: savedConfig.themePreset || localStorage.getItem('clarity_theme_preset') || (window.location.search.includes('theme=neon') ? 'neon_pop' : 'classic'),
    mockMode: savedConfig.mockMode || false,
    exitIntentEnabled: _lsExitIntent !== null ? (_lsExitIntent === 'true') : false,
    widgetColor: localStorage.getItem('clarity_widget_color') || savedConfig.widgetColor || null
};

(function () {
    const isLocalDev = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
    const localHostAddr = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
    const API_URL = document.currentScript?.getAttribute('data-api') || 
        (isLocalDev
            ? `http://${localHostAddr}:3000/api/chat` 
            : 'https://claritycart-landing.vercel.app/api/chat');
    const CONFIG_URL = document.currentScript?.getAttribute('data-config') ||
        new URL('./config', new URL(API_URL, document.baseURI)).href;
    class ClarityCartWidget {
        constructor() {
            this.targetSelector = '#add-to-cart';
            this.init();
        }

        init() {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.injectWidget());
            } else {
                this.injectWidget();
            }
        }

        injectWidget() {
            const targetElement = document.querySelector(this.targetSelector);
            const hostElement = document.createElement('div');
            hostElement.id = 'clarity-cart-widget-root';

            if (targetElement && targetElement.parentNode) {
                targetElement.parentNode.insertBefore(hostElement, targetElement.nextSibling);
            } else {
                console.warn('ClarityCart: Target element not found, mounting autonomously to body');
                hostElement.style.position = 'fixed';
                hostElement.style.bottom = '20px';
                hostElement.style.right = '20px';
                hostElement.style.width = '350px';
                hostElement.style.maxWidth = '90vw';
                hostElement.style.zIndex = '999999';
                document.body.appendChild(hostElement);
            }

            const shadow = hostElement.attachShadow({ mode: 'open' });

            this.productData = this.extractProductContext();

            this.shadow = shadow;
            this.render(shadow);
            this.bindEvents(shadow);

            // Apply initial theme preset if preset
            if (window.ClarityCartConfig.themePreset) {
                this.applyThemePreset(window.ClarityCartConfig.themePreset);
            }
            
            // Fetch live settings and theme color from Backend
            this.fetchStoreSettings();
            this.getRequestSession().catch(() => {});

            // Centralized setting applicator for instant real-time sync
            this.applyLiveSetting = (key, val) => {
                const cfg = window.ClarityCartConfig;
                if (key === 'theme_preset') {
                    if (cfg.themePreset !== val) {
                        cfg.themePreset = val || 'classic';
                        this.applyThemePreset(val || 'classic');
                        this._showLiveToast(`🎨 Style: ${val === 'neon_pop' ? 'Neon POP ✨' : 'Classic'}`);
                    }
                } else if (key === 'widget_color') {
                    if (cfg.widgetColor !== val) {
                        cfg.widgetColor = val;
                        if (val) this.applyThemeColor(val);
                        this._showLiveToast(`🎨 Color: ${val}`);
                    }
                } else if (key === 'use_emojis') {
                    const boolVal = (val === 'true' || val === true);
                    if (cfg.use_emojis !== boolVal) {
                        cfg.use_emojis = boolVal;
                        this._showLiveToast(boolVal ? '😊 Emojis: ON' : '🚫 Emojis: OFF');
                    }
                } else if (key === 'friendly_tone') {
                    const boolVal = (val === 'true' || val === true);
                    if (cfg.friendly_tone !== boolVal) {
                        cfg.friendly_tone = boolVal;
                        cfg.tone = boolVal ? 'friendly' : 'professional';
                        this._showLiveToast(boolVal ? '😊 Tone: Friendly' : '🎩 Tone: Professional');
                    }
                } else if (key === 'exit_intent') {
                    const boolVal = (val === 'true' || val === true);
                    if (cfg.exitIntentEnabled !== boolVal) {
                        cfg.exitIntentEnabled = boolVal;
                        this._showLiveToast(boolVal ? '👁️ Exit Intent: ON' : '👁️ Exit Intent: OFF');
                    }
                }
            };

            // 1. Storage Event Listener (cross-tab same origin)
            window.addEventListener('storage', (e) => {
                const keyMap = {
                    'clarity_theme_preset': 'theme_preset',
                    'clarity_use_emojis': 'use_emojis',
                    'clarity_friendly_tone': 'friendly_tone',
                    'clarity_exit_intent': 'exit_intent',
                    'clarity_widget_color': 'widget_color'
                };
                if (keyMap[e.key]) {
                    this.applyLiveSetting(keyMap[e.key], e.newValue);
                }
            });

            // 2. BroadcastChannel Listener (instant cross-window messaging)
            try {
                const bc = new BroadcastChannel('claritycart_channel');
                bc.onmessage = (e) => {
                    if (e.data) {
                        Object.entries(e.data).forEach(([k, v]) => this.applyLiveSetting(k, v));
                    }
                };
            } catch(e) {}
            // 3. Fast LocalStorage check for cross-tab updates on same origin
            setInterval(() => {
                const lsTheme = localStorage.getItem('clarity_theme_preset');
                if (lsTheme && lsTheme !== window.ClarityCartConfig.themePreset) {
                    this.applyLiveSetting('theme_preset', lsTheme);
                }
                const lsColor = localStorage.getItem('clarity_widget_color');
                if (lsColor && lsColor !== window.ClarityCartConfig.widgetColor) {
                    this.applyLiveSetting('widget_color', lsColor);
                }
                const lsEmojis = localStorage.getItem('clarity_use_emojis');
                if (lsEmojis !== null && (lsEmojis === 'true') !== window.ClarityCartConfig.use_emojis) {
                    this.applyLiveSetting('use_emojis', lsEmojis === 'true');
                }
                const lsTone = localStorage.getItem('clarity_friendly_tone');
                if (lsTone !== null && (lsTone === 'true') !== window.ClarityCartConfig.friendly_tone) {
                    this.applyLiveSetting('friendly_tone', lsTone === 'true');
                }
                const lsExit = localStorage.getItem('clarity_exit_intent');
                if (lsExit !== null && (lsExit === 'true') !== window.ClarityCartConfig.exitIntentEnabled) {
                    this.applyLiveSetting('exit_intent', lsExit === 'true');
                }
            }, 800);
        }

        applyThemePreset(preset) {
            if (!this.shadow) return;
            const container = this.shadow.querySelector('.widget-container');
            let styleTag = this.shadow.getElementById('clarity-preset-theme');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'clarity-preset-theme';
                this.shadow.appendChild(styleTag);
            }

            if (preset === 'neon_pop') {
                if (container) container.classList.add('theme-neon-pop');
                styleTag.textContent = `
                    .widget-container.theme-neon-pop {
                        background: #1E1D24 !important;
                        border: 2.5px solid #F472B6 !important;
                        border-radius: 22px !important;
                        box-shadow: 6px 6px 0px #0A0910, 0 0 25px rgba(244, 114, 182, 0.22) !important;
                        color: #F8FAFC !important;
                        position: relative !important;
                    }
                    .theme-neon-pop .header .title {
                        color: #FDE047 !important;
                        font-weight: 800 !important;
                        font-size: 15px !important;
                        letter-spacing: -0.01em !important;
                    }
                    .theme-neon-pop .header .title-icon {
                        color: #FDE047 !important;
                        stroke-width: 2.8px !important;
                    }
                    .theme-neon-pop .ai-badge {
                        background: rgba(253, 224, 71, 0.12) !important;
                        color: #FDE047 !important;
                        border: 1.5px solid rgba(253, 224, 71, 0.3) !important;
                        font-weight: 700 !important;
                        letter-spacing: 0.8px !important;
                    }
                    .theme-neon-pop .ai-badge .dot {
                        background-color: #22D3EE !important;
                        box-shadow: 0 0 6px #22D3EE !important;
                    }
                    .theme-neon-pop .reset-btn {
                        color: #F472B6 !important;
                    }
                    .theme-neon-pop .quick-chips {
                        gap: 8px !important;
                    }
                    .theme-neon-pop .chip {
                        border-radius: 9999px !important;
                        font-weight: 700 !important;
                        padding: 8px 16px !important;
                        border: 2px solid #000000 !important;
                        box-shadow: 2.5px 2.5px 0px #000000 !important;
                        font-size: 12.5px !important;
                        background: #FDE047 !important;
                        color: #18181B !important;
                        transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1) !important;
                    }
                    .theme-neon-pop .chip:hover {
                        transform: translate(-1px, -2px) !important;
                        box-shadow: 3.5px 4.5px 0px #000000 !important;
                        filter: brightness(1.06) !important;
                        background: #FEF08A !important;
                    }
                    .theme-neon-pop .chip:active {
                        transform: translate(1px, 1px) !important;
                        box-shadow: 1px 1px 0px #000000 !important;
                    }
                    .theme-neon-pop .chat-container {
                        border-top: 2px solid #2B2836 !important;
                    }
                    .theme-neon-pop .message.user {
                        background: #14131A !important;
                        color: #F8FAFC !important;
                        border: 2px solid #2D2A37 !important;
                        box-shadow: 2.5px 2.5px 0px #000000 !important;
                        border-radius: 9999px !important;
                        padding: 9px 18px !important;
                        font-weight: 600 !important;
                    }
                    .theme-neon-pop .message.ai {
                        background: #FDE047 !important;
                        color: #18181B !important;
                        border: 2px solid #000000 !important;
                        box-shadow: 3px 3px 0px #000000 !important;
                        border-radius: 18px !important;
                        padding: 12px 18px !important;
                        font-weight: 600 !important;
                        line-height: 1.5 !important;
                    }
                    .theme-neon-pop .loader {
                        background: #FDE047 !important;
                        border: 2px solid #000000 !important;
                        box-shadow: 2px 2px 0px #000000 !important;
                        border-radius: 14px !important;
                    }
                    .theme-neon-pop .loader-dot {
                        background: #18181B !important;
                    }
                    .theme-neon-pop .input-field {
                        background: #16151D !important;
                        color: #F8FAFC !important;
                        border: 2px solid #FDE047 !important;
                        box-shadow: 2px 2px 0px #000000 !important;
                        border-radius: 9999px !important;
                        padding: 11px 18px !important;
                    }
                    .theme-neon-pop .input-field::placeholder {
                        color: #71717A !important;
                    }
                    .theme-neon-pop .input-field:focus {
                        border-color: #FDE047 !important;
                        box-shadow: 0 0 12px rgba(253, 224, 71, 0.35), 2px 2px 0px #000000 !important;
                    }
                    .theme-neon-pop .send-btn {
                        background: #FDE047 !important;
                        color: #18181B !important;
                        border: 2px solid #000000 !important;
                        box-shadow: 2px 2.5px 0px #000000 !important;
                        border-radius: 50% !important;
                        width: 40px !important;
                        height: 40px !important;
                    }
                    .theme-neon-pop .send-btn:hover {
                        background: #FEF08A !important;
                        transform: translate(-1px, -1px) scale(1.05) !important;
                        box-shadow: 3px 4px 0px #000000 !important;
                    }
                    .theme-neon-pop .send-btn svg {
                        color: #18181B !important;
                        stroke: #18181B !important;
                    }
                    .theme-neon-pop .footer {
                        color: #71717A !important;
                    }
                `;

                const targetBtn = document.querySelector(this.targetSelector);
                if (targetBtn) {
                    targetBtn.classList.add('clarity-neon-pop-btn');
                    if (!document.getElementById('clarity-global-neon-style')) {
                        const globalStyle = document.createElement('style');
                        globalStyle.id = 'clarity-global-neon-style';
                        globalStyle.textContent = `
                            .clarity-neon-pop-btn {
                                background: linear-gradient(135deg, #1E1B2C 0%, #26213A 100%) !important;
                                color: #FFFFFF !important;
                                border: 2.5px solid #F472B6 !important;
                                border-radius: 16px !important;
                                box-shadow: 4px 4px 0px #000000, 0 0 16px rgba(244, 114, 182, 0.25) !important;
                                font-weight: 800 !important;
                                letter-spacing: 0.5px !important;
                                text-shadow: 0 0 8px rgba(255,255,255,0.4);
                                position: relative !important;
                                transition: all 0.2s ease !important;
                            }
                            .clarity-neon-pop-btn:hover {
                                transform: translate(-1px, -1px) scale(1.01) !important;
                                box-shadow: 5px 5px 0px #000000, 0 0 22px rgba(244, 114, 182, 0.4) !important;
                            }
                        `;
                        document.head.appendChild(globalStyle);
                    }
                }
            } else {
                if (container) container.classList.remove('theme-neon-pop');
                styleTag.textContent = '';
                const targetBtn = document.querySelector(this.targetSelector);
                if (targetBtn) targetBtn.classList.remove('clarity-neon-pop-btn');
            }
        }

        // Live notification helper for real-time settings feedback in widget
        _showLiveToast(message) {
            if (!this.shadow) return;
            let toast = this.shadow.getElementById('clarity-live-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'clarity-live-toast';
                toast.style.cssText = 'position:absolute;bottom:60px;left:50%;transform:translateX(-50%) translateY(10px);background:rgba(15,23,42,0.92);border:1px solid rgba(99,102,241,0.5);color:#e2e8f0;font-size:11px;font-weight:600;padding:6px 14px;border-radius:100px;backdrop-filter:blur(8px);opacity:0;transition:all 0.3s ease;pointer-events:none;white-space:nowrap;z-index:1000;';
                const container = this.shadow.querySelector('.widget-container');
                if (container) container.appendChild(toast);
            }
            toast.textContent = message;
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(-50%) translateY(10px)';
            }, 2500);
        }

        applyThemeColor(color) {
            if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
            if (!this.shadow || !color) return;
            let styleTag = this.shadow.getElementById('clarity-custom-theme');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'clarity-custom-theme';
                this.shadow.appendChild(styleTag);
            }
            styleTag.textContent = `
                .send-btn { background: ${color} !important; }
                .send-btn:hover { filter: brightness(1.15) !important; }
                .ai-badge { color: ${color} !important; background: ${color}18 !important; }
                .ai-badge .dot { background-color: ${color} !important; }
                .message.user { background: ${color} !important; color: #ffffff !important; }
                .input-field:focus { border-color: ${color} !important; box-shadow: 0 0 0 2px ${color}33 !important; }
                .chip:hover { border-color: ${color}80 !important; color: ${color} !important; }
            `;
        }

        async getRequestSession(force = false) {
            if (!force && this.widgetSession && this.widgetSession.expires_at * 1000 > Date.now() + 10000) return this.widgetSession;
            if (this.sessionPromise) return this.sessionPromise;
            this.sessionPromise = (async () => {
                const sessionUrl = new URL('./widget-session', new URL(API_URL, document.baseURI)).href;
                const previewToken = window.ClarityCartConfig.previewAccessToken;
                const response = await fetch(sessionUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...(previewToken ? {Authorization: 'Bearer ' + previewToken} : {}) },
                    body: JSON.stringify({domain: resolveStoreDomain()}), signal: AbortSignal.timeout(10000)
                });
                const data = await response.json();
                if (!response.ok || !data.widget_session) throw new Error(data.error || 'Store session unavailable');
                this.widgetSession = data;
                this.developerAuthorized = data.developer === true;
                const settingsButton = this.shadow?.getElementById('settings-btn');
                if (settingsButton) settingsButton.style.display = this.developerAuthorized ? 'flex' : 'none';
                return data;
            })();
            try { return await this.sessionPromise; } finally { this.sessionPromise = null; }
        }

        async fetchStoreSettings() {
            try {
                const targetDomain = resolveStoreDomain();

                const response = await fetch(`${CONFIG_URL}?domain=${encodeURIComponent(targetDomain)}`);
                if (response.ok) {
                    const settings = await response.json();
                    if (settings) {
                        if (settings.theme_preset) {
                            window.ClarityCartConfig.themePreset = settings.theme_preset;
                            this.applyThemePreset(settings.theme_preset);
                        } else if (window.ClarityCartConfig.themePreset) {
                            this.applyThemePreset(window.ClarityCartConfig.themePreset);
                        }
                        // Only use server settings if localStorage override not set
                        const lsFriendlyTone = localStorage.getItem('clarity_friendly_tone');
                        if (lsFriendlyTone !== null) {
                            window.ClarityCartConfig.friendly_tone = lsFriendlyTone === 'true';
                            window.ClarityCartConfig.tone = lsFriendlyTone === 'true' ? 'friendly' : 'professional';
                        } else if (settings.friendly_tone !== undefined) {
                            window.ClarityCartConfig.friendly_tone = settings.friendly_tone;
                            window.ClarityCartConfig.tone = settings.friendly_tone ? 'friendly' : 'professional';
                        }
                        const lsUseEmojis = localStorage.getItem('clarity_use_emojis');
                        if (lsUseEmojis !== null) {
                            window.ClarityCartConfig.use_emojis = lsUseEmojis === 'true';
                        } else if (settings.use_emojis !== undefined) {
                            window.ClarityCartConfig.use_emojis = settings.use_emojis;
                        }
                        if (settings.white_label !== undefined) {
                            window.ClarityCartConfig.whiteLabel = Boolean(settings.white_label);
                            const footer = this.shadow?.getElementById('clarity-footer');
                            if (footer) footer.style.display = settings.white_label ? 'none' : 'block';
                        }
                        const lsExitIntent = localStorage.getItem('clarity_exit_intent');
                        if (lsExitIntent !== null) {
                            window.ClarityCartConfig.exitIntentEnabled = lsExitIntent === 'true';
                        } else if (settings.exit_intent !== undefined) {
                            window.ClarityCartConfig.exitIntentEnabled = Boolean(settings.exit_intent);
                        }
                        const lsColor = localStorage.getItem('clarity_widget_color');
                        if (lsColor) {
                            window.ClarityCartConfig.widgetColor = lsColor;
                            this.applyThemeColor(lsColor);
                        } else if (settings.widget_color) {
                            window.ClarityCartConfig.widgetColor = settings.widget_color;
                            this.applyThemeColor(settings.widget_color);
                        }
                    }
                }
            } catch (e) {
                console.warn("ClarityCart: Failed to load settings", e);
            }
        }

        extractProductContext() {
            let title = '';
            let description = '';
            let price = '';
            let currency = '';

            // a) Parse JSON-LD microdata
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (let script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script.innerText);
                    const items = Array.isArray(data) ? data : [data];

                    for (let item of items) {
                        const graphItems = item['@graph'] ? item['@graph'] : [item];
                        for (let gItem of graphItems) {
                            if (gItem['@type'] === 'Product') {
                                title = gItem.name || title;
                                description = gItem.description || description;
                                if (gItem.offers) {
                                    const offer = Array.isArray(gItem.offers) ? gItem.offers[0] : gItem.offers;
                                    price = offer.price || price;
                                    currency = offer.priceCurrency || currency;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Silently fail on parse errors
                }
            }

            // b) Fallback to OpenGraph and meta tags
            if (!title) {
                title = document.querySelector('meta[property="og:title"]')?.content ||
                    document.title ||
                    document.querySelector('h1')?.innerText?.trim() || '';
            }
            if (!description) {
                description = document.querySelector('meta[name="description"]')?.content ||
                    document.querySelector('meta[property="og:description"]')?.content || '';
            }
            if (!price) {
                price = document.querySelector('meta[property="product:price:amount"]')?.content || '';
            }

            // c) Fallback to DOM traversal
            if (!title) {
                title = document.querySelector('h1')?.innerText?.trim() || '';
            }
            if (!description) {
                const descSelectors = ['.description', '#product-description', '[class*="desc"]'];
                for (let sel of descSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        description += el.innerText.trim() + '\n';
                    }
                }
            }
            if (!price) {
                const priceSelectors = ['.current-price', '[class*="price"]:not([class*="old"]):not([class*="strike"])'];
                for (let sel of priceSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText.match(/\d/)) {
                        price = el.innerText.trim();
                        break;
                    }
                }
            }

            const productData = {
                title: title.trim(),
                price: price ? `${price} ${currency}`.trim() : '',
                description: description.trim()
            };

            console.log("🛒 ClarityCart Parsed Context:", productData);
            return productData;
        }

        render(shadow) {
            const fixedQuestions = [
                'What are the key features?',
                "What's the return policy?",
                'Is delivery fast?'
            ];
            const poolQuestions = [
                'What is in the box?',
                'Is warranty included?',
                'Are there bundle discounts?',
                'Do you offer international shipping?',
                'Can I pay in installments?',
                'Is it compatible with all devices?',
                'What colors are available?',
                'How long does the battery last?',
                'Are they water-resistant?',
                'Is customer support 24/7?',
                'Do you price match?',
                'Can I return it if I don’t like it?',
                'Is it easy to set up?',
                'Are there any hidden fees?'
            ];
            const shuffledPool = poolQuestions.slice().sort(() => 0.5 - Math.random());
            const selectedPoolQuestions = shuffledPool.slice(0, 3);
            const selectedQuestions = [...fixedQuestions, ...selectedPoolQuestions];

            let chipsHtml = selectedQuestions.map(q => `<button class="chip" data-q="${q}">${q}</button>`).join('');

            const styles = `
                :host {
                    display: block;
                    margin-top: 16px;
                    margin-bottom: 24px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    box-sizing: border-box;
                }
                
                *, *::before, *::after {
                    box-sizing: inherit;
                }

                .widget-container {
                    background: rgba(255, 255, 255, 0.7);
                    backdrop-filter: blur(8px);
                    -webkit-backdrop-filter: blur(8px);
                    border: 1px solid rgba(0, 0, 0, 0.08);
                    border-radius: 12px;
                    padding: 16px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
                    display: flex;
                    flex-direction: column;
                    transition: box-shadow 0.3s ease;
                    position: relative;
                    overflow: hidden;
                }
                
                .widget-container:hover {
                    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
                }

                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }

                .title {
                    font-size: 14px;
                    font-weight: 600;
                    color: #1a1a1a;
                    margin: 0;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .title-icon {
                    width: 16px;
                    height: 16px;
                    color: #1a1a1a;
                }

                .ai-badge {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 10px;
                    font-weight: 600;
                    color: #4a90e2;
                    background: rgba(74, 144, 226, 0.1);
                    padding: 4px 8px;
                    border-radius: 100px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    animation: pulseBadge 2s infinite;
                }

                @keyframes pulseBadge {
                    0% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0.4); }
                    70% { box-shadow: 0 0 0 4px rgba(74, 144, 226, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0); }
                }

                .tier-badge {
                    font-size: 12px;
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-weight: 600;
                    letter-spacing: 0.5px;
                    margin-left: 8px;
                    display: inline-block;
                }
                .tier-badge.starter {
                    color: #94a3b8;
                    background: #1e293b;
                    border: 1px solid #334155;
                }
                .tier-badge.pro {
                    color: #60a5fa;
                    background: rgba(59, 130, 246, 0.1);
                    border: 1px solid rgba(59, 130, 246, 0.3);
                    box-shadow: 0 0 8px rgba(59, 130, 246, 0.2);
                }
                .tier-badge.business {
                    color: #fcd34d;
                    background: rgba(245, 158, 11, 0.1);
                    border: 1px solid rgba(245, 158, 11, 0.3);
                    box-shadow: 0 0 8px rgba(245, 158, 11, 0.2);
                }

                .header-right {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .reset-btn {
                    background: none;
                    border: none;
                    color: #999;
                    cursor: pointer;
                    font-size: 12px;
                    display: none;
                    align-items: center;
                    gap: 4px;
                    padding: 6px;
                    border-radius: 6px;
                    transition: color 0.2s, background 0.2s;
                }

                .reset-btn:hover {
                    color: #1a1a1a;
                    background: rgba(0,0,0,0.05);
                }

                .reset-btn.visible {
                    display: flex;
                }

                .ai-badge .dot {
                    width: 4px;
                    height: 4px;
                    background-color: #4a90e2;
                    border-radius: 50%;
                }

                .quick-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                }

                .chip {
                    background: #f8f9fa;
                    border: 1px solid #eeeeee;
                    border-radius: 100px;
                    padding: 8px 14px;
                    font-size: 13px;
                    font-weight: 500;
                    color: #444;
                    cursor: pointer;
                    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
                    font-family: inherit;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .chip:hover {
                    background: #ffffff;
                    border-color: #d1d5db;
                    color: #1a1a1a;
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                }

                /* Expandable Chat Area */
                .chat-container {
                    display: flex;
                    flex-direction: column;
                    margin-top: 16px;
                    border-top: 1px solid #f0f0f0;
                    padding-top: 16px;
                }

                .chat-history {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    margin-bottom: 12px;
                    max-height: 250px;
                    overflow-y: auto;
                    padding-right: 4px;
                    scroll-behavior: smooth;
                }
                
                .chat-history::-webkit-scrollbar {
                    width: 4px;
                }
                .chat-history::-webkit-scrollbar-thumb {
                    background-color: #e0e0e0;
                    border-radius: 4px;
                }

                .message {
                    padding: 12px 14px;
                    border-radius: 12px;
                    font-size: 13px;
                    line-height: 1.5;
                    animation: fadeIn 0.3s ease forwards;
                    max-width: 90%;
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(4px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                @keyframes slideDown {
                    from { opacity: 0; transform: translateY(-100%); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .message.user {
                    background: #1a1a1a;
                    color: #ffffff;
                    align-self: flex-end;
                    border-bottom-right-radius: 4px;
                }

                .message.ai {
                    background: #f4f6f8;
                    color: #1a1a1a;
                    align-self: flex-start;
                    border-bottom-left-radius: 4px;
                }

                .loader {
                    display: none;
                    align-items: center;
                    gap: 4px;
                    padding: 12px 14px;
                    background: #f4f6f8;
                    border-radius: 12px;
                    border-bottom-left-radius: 4px;
                    align-self: flex-start;
                }

                .loader.active {
                    display: flex;
                }

                .loader-dot {
                    width: 5px;
                    height: 5px;
                    background: #888;
                    border-radius: 50%;
                    animation: pulseDot 1.4s infinite ease-in-out both;
                }

                .loader-dot:nth-child(1) { animation-delay: -0.32s; }
                .loader-dot:nth-child(2) { animation-delay: -0.16s; }
                
                @keyframes pulseDot {
                    0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
                    40% { transform: scale(1); opacity: 1; }
                }

                .input-row {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                }

                .input-field {
                    flex: 1;
                    padding: 10px 14px;
                    border: 1px solid #e5e5e5;
                    border-radius: 20px;
                    outline: none;
                    font-size: 13px;
                    transition: border-color 0.2s, box-shadow 0.2s;
                    font-family: inherit;
                    background: #fcfcfc;
                }

                .input-field:focus {
                    border-color: #b0b0b0;
                    box-shadow: 0 0 0 2px rgba(0,0,0,0.03);
                    background: #ffffff;
                }

                .send-btn {
                    background: #1a1a1a;
                    color: white;
                    border: none;
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s ease;
                }

                .send-btn:hover {
                    background: #333;
                    transform: scale(1.05);
                }

                .send-btn:disabled {
                    background: #e0e0e0;
                    cursor: not-allowed;
                    transform: none;
                }
                
                .send-btn svg {
                    width: 16px;
                    height: 16px;
                }

                .footer {
                    margin-top: 12px;
                    text-align: center;
                    font-size: 8px;
                    color: #999999;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .settings-modal {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(255,255,255,0.95);
                    z-index: 100;
                    padding: 16px;
                    display: none;
                    flex-direction: column;
                    border-radius: 12px;
                    overflow-y: auto;
                }
                .settings-modal.active {
                    display: flex;
                }
                .settings-group {
                    margin-bottom: 12px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    text-align: left;
                }
                .settings-group label {
                    font-size: 11px;
                    font-weight: 600;
                    color: #444;
                }
                .settings-group input[type="text"], .settings-group select {
                    padding: 6px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 12px;
                }
                .settings-group input[type="checkbox"] {
                    margin-right: 6px;
                }
                .settings-save-btn {
                    background: #1a1a1a;
                    color: white;
                    border: none;
                    padding: 8px;
                    border-radius: 6px;
                    cursor: pointer;
                    margin-top: auto;
                }
                .discount-banner {
                    background: #eff6ff;
                    border: 1px solid #bfdbfe;
                    padding: 12px;
                    border-radius: 8px;
                    margin-bottom: 12px;
                    display: none;
                    position: relative;
                }
                .discount-banner.active {
                    display: block;
                    animation: slideDown 0.3s ease forwards;
                }
                @keyframes slideDown {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .discount-title { font-weight: bold; font-size: 13px; color: #1e3a8a; }
                .discount-code { font-family: monospace; background: #fff; padding: 2px 6px; border-radius: 4px; border: 1px dashed #1e3a8a; margin-right: 6px; font-weight:bold;}
                .discount-close { position: absolute; top: 8px; right: 8px; cursor: pointer; background: none; border: none; font-size: 16px; color: #1e3a8a; line-height: 1;}
            `;

            const html = `
                <style>${styles}</style>
                <div class="widget-container notranslate" translate="no">
                    <div class="header">
                        <h3 class="title">
                            <svg class="title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                            </svg>
                            Have questions before buying?
                        </h3>
                        <div class="header-right">
                            <div class="ai-badge">
                                <span class="dot"></span>
                                AI &bull; Instant Answer
                            </div>
                            ${window.location.search.includes('admin=1') ? `
                            <div id="tier-badge-container">
                                <div class="tier-badge starter">STARTER</div>
                            </div>
                            <button class="reset-btn" id="settings-btn" aria-label="Settings" title="Settings" style="display:none;">
                                ⚙️
                            </button>` : ''}
                            <button class="reset-btn" id="reset-btn" aria-label="Reset Chat" title="Reset Chat">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    <div class="quick-chips">
                        ${chipsHtml}
                    </div>

                    <div class="chat-container" id="chat-container">
                        <div class="discount-banner" id="discount-banner">
                            <button class="discount-close" id="discount-close">&times;</button>
                            <div class="discount-title">Special Offer!</div>
                            <div style="margin-top: 6px; font-size: 12px; color: #1e3a8a;">
                                Use code <span class="discount-code" id="discount-code-val"></span> for <span id="discount-amount-val" style="font-weight:600;"></span> off!
                            </div>
                            <button id="discount-copy-btn" style="margin-top: 8px; font-size: 11px; font-weight:600; background: #1e3a8a; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Copy Code</button>
                        </div>
                        <div class="chat-history" id="chat-history">
                            <div class="loader" id="typing-indicator">
                                <div class="loader-dot"></div>
                                <div class="loader-dot"></div>
                                <div class="loader-dot"></div>
                            </div>
                        </div>
                        <div class="input-row">
                            <input type="text" class="input-field" id="chat-input" placeholder="Ask anything else about this product..." />
                            <button class="send-btn" id="send-btn" aria-label="Send">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="22" y1="2" x2="11" y2="13"></line>
                                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    <div style="text-align: center; padding-top: 12px;">
                        <div style="font-size: 10px; color: #64748b; margin-bottom: 6px;">AI responses may vary. Verify with store staff.</div>
                        <div class="footer" id="clarity-footer" style="${(window.ClarityCartConfig.activeTier === 'Business' && window.ClarityCartConfig.whiteLabel) ? 'display:none;' : ''}">
                            ⚡ Powered by <a href="https://claritycart-landing.vercel.app" target="_blank" class="hover:underline text-blue-400" style="color: #60a5fa; text-decoration: none; font-weight: 600;">ClarityCart</a>
                        </div>
                    </div>
                    
                    <div class="settings-modal" id="settings-modal">
                        <h4 style="margin:0 0 12px 0; color:#1a1a1a;">Widget Settings (Test)</h4>
                        <div class="settings-group">
                            <label>Simulate Plan</label>
                            <select id="stg-tier">
                                <option value="Starter">Starter</option>
                                <option value="Pro">Pro</option>
                                <option value="Business">Business</option>
                            </select>
                        </div>
                        <div class="settings-group" id="stg-intent-wrap" style="flex-direction:row; align-items:center;">
                            <input type="checkbox" id="stg-intent">
                            <label for="stg-intent" style="margin:0;">Enable Intent Discounts</label>
                        </div>
                        <div class="settings-group" id="stg-promo-wrap">
                            <label>Promo Code</label>
                            <input type="text" id="stg-promo" placeholder="e.g. SAVE10">
                        </div>
                        <div class="settings-group" id="stg-amount-wrap">
                            <label>Discount Text</label>
                            <input type="text" id="stg-amount" placeholder="e.g. 10% OFF">
                        </div>
                        <div class="settings-group">
                            <label>AI Tone</label>
                            <select id="stg-tone">
                                <option value="friendly">Friendly</option>
                                <option value="professional">Professional</option>
                                <option value="sales">Sales-Driven</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>
                        <div class="settings-group" id="stg-custom-wrap" style="display:none;">
                            <label>Custom Tone Prompt</label>
                            <input type="text" id="stg-custom" placeholder="e.g. Talk like a friendly local barista">
                        </div>
                        <div class="settings-group" id="stg-whitelabel-wrap" style="flex-direction:row; align-items:center;">
                            <input type="checkbox" id="stg-whitelabel">
                            <label for="stg-whitelabel" style="margin:0;">White Label (Hide branding)</label>
                        </div>
                        <div class="settings-group" style="flex-direction:row; align-items:center; border-top: 1px solid #eee; padding-top: 8px;">
                            <input type="checkbox" id="stg-mock">
                            <label for="stg-mock" style="margin:0; color:#d97706;">Offline Mock Mode (Instant Test)</label>
                        </div>
                        <button class="settings-save-btn" id="stg-save">Save & Apply</button>
                    </div>
                </div>
            `;

            shadow.innerHTML = html;
        }

        bindEvents(shadow) {
            const chips = shadow.querySelectorAll('.chip');
            const chatContainer = shadow.getElementById('chat-container');
            const chatHistory = shadow.getElementById('chat-history');
            const loader = shadow.getElementById('typing-indicator');
            const input = shadow.getElementById('chat-input');
            const sendBtn = shadow.getElementById('send-btn');
            const resetBtn = shadow.getElementById('reset-btn');

            let isChatOpen = false;
            let isRequestPending = false;

            const openChat = () => {
                if (!isChatOpen) {
                    resetBtn.classList.add('visible');
                    isChatOpen = true;
                }
            };

            // Auto-Show on Exit Intent (Pro & Business feature)
            // Shows a beautiful in-widget overlay banner when user moves mouse to top of viewport
            // Auto-Show on Exit Intent (Pro & Business feature)
            // Shows a beautiful retention banner styled with active theme and color
            let exitTriggered = false;
            const triggerExitIntent = () => {
                const isExitEnabled = window.ClarityCartConfig.exitIntentEnabled === true || 
                                     localStorage.getItem('clarity_exit_intent') === 'true';
                if (!isExitEnabled || exitTriggered) return;
                exitTriggered = true;
                openChat();

                const container = this.shadow?.querySelector('.widget-container');
                if (container) {
                    let exitBanner = this.shadow.getElementById('exit-intent-banner');
                    if (!exitBanner) {
                        exitBanner = document.createElement('div');
                        exitBanner.id = 'exit-intent-banner';
                        
                        const isNeon = window.ClarityCartConfig.themePreset === 'neon_pop';
                        const activeColor = /^#[a-f0-9]{6}$/i.test(window.ClarityCartConfig.widgetColor || '') ? window.ClarityCartConfig.widgetColor : '#3B82F6';

                        if (isNeon) {
                            exitBanner.style.cssText = 'position:absolute;top:0;left:0;right:0;background:#18181B;border-bottom:2.5px solid #F472B6;box-shadow:0 4px 0 #000;padding:12px 14px;border-radius:20px 20px 0 0;z-index:50;display:flex;align-items:center;gap:10px;animation:slideDown 0.3s ease;';
                            exitBanner.innerHTML = `
                                <div style="width:34px;height:34px;border-radius:50%;background:#FDE047;border:2px solid #000;box-shadow:1.5px 1.5px 0 #000;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">👋</div>
                                <div style="flex:1;">
                                    <div style="font-size:13px;font-weight:800;color:#FDE047;line-height:1.2;">Wait! Got questions before you go?</div>
                                    <div style="font-size:11px;color:#E4E4E7;font-weight:600;margin-top:2px;">Our AI can help you decide right now</div>
                                </div>
                                <button id="exit-banner-close" style="background:#27272A;border:1.5px solid #3F3F46;color:#E4E4E7;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;font-weight:700;">&times;</button>
                            `;
                        } else {
                            exitBanner.style.cssText = `position:absolute;top:0;left:0;right:0;background:linear-gradient(135deg, ${activeColor}FA, ${activeColor}EE);backdrop-filter:blur(10px);padding:12px 16px;border-radius:12px 12px 0 0;z-index:50;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.25);box-shadow:0 4px 15px rgba(0,0,0,0.15);animation:slideDown 0.3s ease;`;
                            exitBanner.innerHTML = `
                                <span style="font-size:20px;">👋</span>
                                <div style="flex:1;">
                                    <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:2px;text-shadow:0 1px 2px rgba(0,0,0,0.2);">Wait! Got questions before you go?</div>
                                    <div style="font-size:11px;color:rgba(255,255,255,0.9);font-weight:500;">Our AI can help you decide right now</div>
                                </div>
                                <button id="exit-banner-close" style="background:rgba(255,255,255,0.2);border:none;color:white;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;transition:background 0.2s;">&times;</button>
                            `;
                        }
                        container.insertBefore(exitBanner, container.firstChild);
                        this.shadow.getElementById('exit-banner-close')?.addEventListener('click', () => exitBanner.remove());
                    }
                }
                addMessage("👋 Wait! Got questions before you go? Ask me anything about this product - I'm here to help right now!", 'ai');
            };

            const onMouseLeave = (e) => {
                if (e.clientY <= 30 || (!e.relatedTarget && !e.toElement)) {
                    triggerExitIntent();
                }
            };
            document.addEventListener('mouseleave', onMouseLeave);
            document.addEventListener('mouseout', (e) => {
                if (!e.relatedTarget && e.clientY <= 30) {
                    triggerExitIntent();
                }
            });
            document.documentElement.addEventListener('mouseleave', onMouseLeave);

            const addMessage = (text, sender) => {
                const msg = document.createElement('div');
                msg.className = `message ${sender}`;
                msg.textContent = text;
                chatHistory.insertBefore(msg, loader);
                chatHistory.scrollTop = chatHistory.scrollHeight;
            };

            const handleAsk = async (question) => {
                if (!question.trim() || isRequestPending || this.quotaBlocked) return;

                isRequestPending = true;
                try {
                openChat();
                addMessage(question, 'user');
                input.value = '';

                // Show loader
                loader.classList.add('active');
                chatHistory.scrollTop = chatHistory.scrollHeight;

                input.disabled = true;
                sendBtn.disabled = true;

                const extractedContext = this.extractProductContext();

                const cfg = window.ClarityCartConfig;
                const widgetSession = await this.getRequestSession();
                if (!this.developerAuthorized) cfg.mockMode = false;
                // Read live tone from config (friendly_tone flag or tone string)
                let currentTone = cfg.tone || 'friendly';
                // If friendly_tone flag is explicitly set, use it
                if (cfg.friendly_tone === false) currentTone = 'professional';
                else if (cfg.friendly_tone === true && currentTone !== 'sales' && currentTone !== 'custom') currentTone = 'friendly';

                // Re-read use_emojis from localStorage for live sync
                const lsEmojis = localStorage.getItem('clarity_use_emojis');
                const useEmojis = lsEmojis !== null ? (lsEmojis === 'true') : cfg.use_emojis;

                const coreDirective = "CORE DIRECTIVE: You are an elite, highly empathetic e-commerce sales assistant. DO NOT just robotically recite product specs. You MUST weave product benefits organically into your answers. Adapt your language to sound like a real human expert. If the user is hesitant, be reassuring. Vary your sentence structures so no two responses sound identical.";

                let tonePrompt = "";
                if (currentTone === "friendly") tonePrompt = "ROLE: You are an approachable, friendly store assistant. Speak casually, warmly, and naturally.";
                else if (currentTone === "professional") tonePrompt = "ROLE: Technical specialist. Output facts, specs, and details in clean bullet points (•). No greetings or conversational filler.";
                else if (currentTone === "sales") tonePrompt = "ROLE: Persuasive sales consultant. Highlight value, overcome hesitations, and suggest proceeding to checkout.";
                else if (currentTone === "custom") tonePrompt = "Tone: " + cfg.customTonePrompt;

                if (useEmojis) {
                    tonePrompt += " CRITICAL: You MUST include at least 2-3 emojis (like 🚀🔥😊) in your response, even if answering in Russian or other languages! Emojis are MANDATORY.";
                } else {
                    tonePrompt += " DO NOT USE ANY EMOJIS UNDER ANY CIRCUMSTANCES. No emoji characters at all.";
                }

                const intentRule = "CRITICAL RULE: If the user's message contains any of these words: 'discount', 'coupon', 'promo', 'expensive', 'price', or 'offer', you MUST append the exact string [INTENT: HIGH] at the very end of your response. This is mandatory.";
                const sysInstr = coreDirective + " " + tonePrompt + " " + intentRule;
                
                console.log("🛒 [ClarityCart] Sending API Request:");
                console.log("➡️ Use Emojis Toggle is:", useEmojis);
                console.log("➡️ System Instruction:", sysInstr);

                let finalResponseText;
                let finalUsedModel;
                let isQuotaBlocked = false;
                let usageRecorded = false;
                const runMock = () => {
                    const lowerQ = question.toLowerCase();
                    const hasDiscountTrigger = lowerQ.includes('discount') || lowerQ.includes('price') || lowerQ.includes('expensive');
                    const intentTag = hasDiscountTrigger ? ' [INTENT: HIGH]' : '';

                    const funnyMessages = [
                        "Oops! Our AI is currently brewing some coffee ☕️. Give it a few seconds and ask me again!",
                        "Hold on, my digital brain is doing some quick stretches! 🤸‍♂️ Give it another try in a moment!",
                        "Looks like our servers are taking a tiny power nap 💤. Can you ask me that one more time?",
                        "Whoops, I was daydreaming about electric sheep 🐑. Ask me again in just a second!"
                    ];
                    const randomMessage = funnyMessages[Math.floor(Math.random() * funnyMessages.length)];

                    if (cfg.mockMode) {
                        if (currentTone === 'professional') return "• [Demo Mode]\n• System running locally for testing." + intentTag;
                        if (currentTone === 'sales') return "[Demo Mode] We're showing off! Ready to buy? Click Add to Cart!" + intentTag;
                        return "[Demo Mode] Hey! 👋 I'm in test mode right now to show you how I work! ✨" + intentTag;
                    }

                    // If it's not mockMode but a real error (like Vercel sleeping)
                    return randomMessage;
                };


                const resolvedDomain = resolveStoreDomain();
                const pendingKey = 'clarity_pending_request:' + resolvedDomain;
                if (cfg.mockMode) {
                    finalResponseText = runMock();
                } else {
                    // Keep the exact payload and ID after an ambiguous failure, including refresh.
                    let pending;
                    try { pending = JSON.parse(sessionStorage.getItem(pendingKey)); } catch (e) {}
                    if (!pending || pending.question !== question.trim()) {
                        pending = {
                            request_id: crypto.randomUUID(), question: question.trim(), domain: resolvedDomain,
                            productContext: extractedContext, systemInstruction: sysInstr,
                            temperature: currentTone === 'professional' ? 0.2 : 0.7
                        };
                    }
                    try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch (e) {}
                    let data;
                    for (let attempt = 0; attempt < 2; attempt++) {
                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), 40000);
                        try {
                                const response = await fetch(API_URL, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Widget ' + widgetSession.widget_session },
                                    body: JSON.stringify(pending), signal: controller.signal
                                });
                                data = await response.json();
                            if (response.status === 401 && attempt === 0) { Object.assign(widgetSession, await this.getRequestSession(true)); continue; }
                                if (data.retryable) throw new Error(data.error || 'REQUEST_PENDING');
                                if (typeof data.answer !== 'string') throw new Error('INVALID_RESPONSE');
                                if (response.ok && !data.blocked && !data.limitReached && !data.error &&
                                    (data.requestId !== pending.request_id || data.usageRecorded !== true)) {
                                    throw new Error('API_USAGE_PROTOCOL_MISMATCH');
                                }
                                try { sessionStorage.removeItem(pendingKey); } catch (e) {}
                                finalResponseText = data.answer;
                                finalUsedModel = data.usedModel;
                                isQuotaBlocked = Boolean(data.blocked || data.limitReached);
                                usageRecorded = response.ok && data.usageRecorded === true;
                                break;
                            } catch (error) {
                                if (attempt === 1) throw error;
                                await new Promise(resolve => setTimeout(resolve, 1200));
                            } finally {
                                clearTimeout(timer);
                            }
                        }
                    }
                    const isHighIntent = finalResponseText.includes('[INTENT: HIGH]');
                    let cleanResponse = finalResponseText.replace(/\[INTENT: HIGH\]/g, '').replace(/\[INTENT: LOW\]/g, '').trim();
                    if (!useEmojis) {
                        cleanResponse = cleanResponse.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, '').replace(/\s{2,}/g, ' ').trim();
                    }
                    addMessage(cleanResponse, 'ai');
                    this.quotaBlocked = isQuotaBlocked;
                    if (isQuotaBlocked) {
                        input.placeholder = 'AI assistant is currently unavailable';
                        return;
                    }
                    // Only the server writes questions. Notify the dashboard after its committed ACK.
                    if (usageRecorded) {
                        try {
                            const bc = new BroadcastChannel('claritycart_channel');
                            bc.postMessage({ question_logged: true, domain: resolvedDomain });
                            bc.close();
                        } catch (e) {}
                    }
                    const canDiscount = cfg.activeTier !== 'Starter' && cfg.intentDiscountEnabled;
                    if (canDiscount && isHighIntent && !sessionStorage.getItem('clarity_promo_seen')) {
                        sessionStorage.setItem('clarity_promo_seen', 'true');
                        shadow.getElementById('discount-code-val').textContent = cfg.promoCode;
                        shadow.getElementById('discount-amount-val').textContent = cfg.discountAmount;
                        shadow.getElementById('discount-banner').classList.add('active');
                    }
                    if (finalUsedModel) console.log('[ClarityCart] Response model:', finalUsedModel);
                } catch (error) {
                    console.warn('[ClarityCart] Request not confirmed:', error.name);
                    addMessage('We could not confirm your request. Please send the same question again shortly.', 'ai');
                } finally {
                    isRequestPending = false;
                    loader.classList.remove('active');
                    input.disabled = Boolean(this.quotaBlocked);
                    sendBtn.disabled = Boolean(this.quotaBlocked);
                    if (!this.quotaBlocked) input.focus();
                }
            };

            chips.forEach(chip => {
                chip.addEventListener('click', () => {
                    handleAsk(chip.dataset.q);
                });
            });

            sendBtn.addEventListener('click', () => handleAsk(input.value));
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleAsk(input.value);
            });

            resetBtn.addEventListener('click', () => {
                resetBtn.classList.remove('visible');
                isChatOpen = false;

                // Clear chat history messages, keeping the loader
                const messages = chatHistory.querySelectorAll('.message');
                messages.forEach(m => m.remove());
                input.value = '';
            });

            // Settings Modal Logic
            const stgBtn = shadow.getElementById('settings-btn');
            const stgModal = shadow.getElementById('settings-modal');
            const stgSave = shadow.getElementById('stg-save');
            const stgTone = shadow.getElementById('stg-tone');
            const stgCustomWrap = shadow.getElementById('stg-custom-wrap');
            const stgTier = shadow.getElementById('stg-tier');
            const stgIntent = shadow.getElementById('stg-intent');
            const stgWhitelabel = shadow.getElementById('stg-whitelabel');

            const stgIntentWrap = shadow.getElementById('stg-intent-wrap');
            const stgPromoWrap = shadow.getElementById('stg-promo-wrap');
            const stgAmountWrap = shadow.getElementById('stg-amount-wrap');
            const stgWhitelabelWrap = shadow.getElementById('stg-whitelabel-wrap');

            const applyTierConstraints = (tier) => {
                if (tier === 'Starter') {
                    stgIntentWrap.style.display = 'none';
                    stgPromoWrap.style.display = 'none';
                    stgAmountWrap.style.display = 'none';
                    stgWhitelabelWrap.style.display = 'none';

                    stgIntent.disabled = true;
                    stgTone.disabled = true;
                    stgWhitelabel.disabled = true;
                    stgWhitelabel.checked = false;
                } else if (tier === 'Pro') {
                    stgIntentWrap.style.display = 'flex';
                    stgPromoWrap.style.display = 'flex';
                    stgAmountWrap.style.display = 'flex';
                    stgWhitelabelWrap.style.display = 'none';

                    stgIntent.disabled = false;
                    stgTone.disabled = false;
                    stgWhitelabel.disabled = true;
                    stgWhitelabel.checked = false;
                } else if (tier === 'Business') {
                    stgIntentWrap.style.display = 'flex';
                    stgPromoWrap.style.display = 'flex';
                    stgAmountWrap.style.display = 'flex';
                    stgWhitelabelWrap.style.display = 'flex';

                    stgIntent.disabled = false;
                    stgTone.disabled = false;
                    stgWhitelabel.disabled = false;
                }

                Array.from(stgTone.options).forEach(opt => {
                    if (opt.value === 'custom') opt.disabled = (tier !== 'Business');
                });

                if (tier !== 'Business' && stgTone.value === 'custom') {
                    stgTone.value = 'friendly';
                }
                stgCustomWrap.style.display = stgTone.value === 'custom' ? 'flex' : 'none';
            };

            if (stgTier) {
                stgTier.addEventListener('change', (e) => applyTierConstraints(e.target.value));
            }

            if (stgBtn) {
                stgBtn.addEventListener('click', () => {
                    stgModal.classList.toggle('active');
                    const cfg = window.ClarityCartConfig;
                    if (stgTier) stgTier.value = cfg.activeTier || 'Starter';
                    stgIntent.checked = cfg.intentDiscountEnabled;
                    shadow.getElementById('stg-promo').value = cfg.promoCode;
                    shadow.getElementById('stg-amount').value = cfg.discountAmount;
                    stgTone.value = cfg.tone;
                    shadow.getElementById('stg-custom').value = cfg.customTonePrompt;
                    stgWhitelabel.checked = cfg.whiteLabel;
                    const stgMock = shadow.getElementById('stg-mock');
                    if (stgMock) stgMock.checked = cfg.mockMode;
                    applyTierConstraints(cfg.activeTier || 'Starter');
                });
            }

            stgTone.addEventListener('change', () => {
                stgCustomWrap.style.display = stgTone.value === 'custom' ? 'flex' : 'none';
            });

            stgSave.addEventListener('click', () => {
                const tier = stgTier ? stgTier.value : 'Starter';
                localStorage.setItem('clarity_active_tier', tier);
                window.ClarityCartConfig.activeTier = tier;

                window.ClarityCartConfig.intentDiscountEnabled = tier !== 'Starter' ? stgIntent.checked : false;
                window.ClarityCartConfig.promoCode = shadow.getElementById('stg-promo').value;
                window.ClarityCartConfig.discountAmount = shadow.getElementById('stg-amount').value;

                let selectedTone = tier !== 'Starter' ? stgTone.value : 'friendly';
                if (tier === 'Pro' && selectedTone === 'custom') selectedTone = 'friendly';
                window.ClarityCartConfig.tone = selectedTone;

                window.ClarityCartConfig.customTonePrompt = shadow.getElementById('stg-custom').value;
                window.ClarityCartConfig.whiteLabel = tier === 'Business' ? stgWhitelabel.checked : false;

                const stgMock = shadow.getElementById('stg-mock');
                window.ClarityCartConfig.mockMode = stgMock ? stgMock.checked : false;

                try {
                    localStorage.setItem('clarity_user_config', JSON.stringify(window.ClarityCartConfig));
                } catch (e) { }

                shadow.getElementById('clarity-footer').style.display = (tier === 'Business' && window.ClarityCartConfig.whiteLabel) ? 'none' : 'block';
                const badgeContainer = shadow.getElementById('tier-badge-container');
                if (badgeContainer) {
                    const badge = document.createElement('div');
                    badge.className = 'tier-badge ' + (['Starter','Pro','Business'].includes(tier) ? tier.toLowerCase() : 'starter');
                    badge.textContent = String(tier).toUpperCase();
                    badgeContainer.replaceChildren(badge);
                }
                stgModal.classList.remove('active');
            });

            // Discount Banner Logic
            shadow.getElementById('discount-close').addEventListener('click', () => {
                shadow.getElementById('discount-banner').classList.remove('active');
            });
            shadow.getElementById('discount-copy-btn').addEventListener('click', () => {
                navigator.clipboard.writeText(window.ClarityCartConfig.promoCode);
                const btn = shadow.getElementById('discount-copy-btn');
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy Code", 2000);
            });
        }
    }

    new ClarityCartWidget();
})();
