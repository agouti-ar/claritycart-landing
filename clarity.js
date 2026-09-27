window.ClarityCartConfig = window.ClarityCartConfig || {
    intentDiscountEnabled: false,
    promoCode: "",
    discountAmount: "",
    whiteLabel: false,
    tone: "friendly",
    customTonePrompt: ""
};

(function() {
    const API_URL = document.currentScript?.getAttribute('data-api') || '/api/chat';
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

            this.render(shadow);
            this.bindEvents(shadow);
        }

        extractProductContext() {
            let title = '';
            let description = '';
            let price = '';
            let currency = '';

            // а) Поиск в микроразметке JSON-LD
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
                    // Игнорируем ошибки парсинга
                }
            }

            // б) Поиск в OpenGraph и мета-тегах
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

            // в) DOM-fallback
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
            const descLower = (this.productData.description || '').toLowerCase();
            const isShoe = descLower.includes('size') || descLower.includes('shoe') || descLower.includes('sneaker') || descLower.includes('running');

            let chipsHtml = '';
            if (isShoe) {
                chipsHtml = `
                    <button class="chip" data-q="Does it run true to size?">Does it run true to size?</button>
                    <button class="chip" data-q="What is the return policy?">What is the return policy?</button>
                    <button class="chip" data-q="Is it good for daily running?">Is it good for daily running?</button>
                    <button class="chip" data-q="Help me pick my size">👟 Help me pick my size</button>
                `;
            } else {
                chipsHtml = `
                    <button class="chip" data-q="What are the key features?">What are the key features?</button>
                    <button class="chip" data-q="What's the return policy?">What's the return policy?</button>
                    <button class="chip" data-q="Is delivery fast?">Is delivery fast?</button>
                `;
            }

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
                            <button class="reset-btn" id="settings-btn" aria-label="Settings" title="Settings" style="display:flex;">
                                ⚙️
                            </button>
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
                        <div class="footer" id="clarity-footer" style="${window.ClarityCartConfig.whiteLabel ? 'display:none;' : ''}">
                            ⚡ Powered by <span style="color:#4a90e2; font-weight:600;">ClarityCart</span>
                        </div>
                    </div>
                    
                    <div class="settings-modal" id="settings-modal">
                        <h4 style="margin:0 0 12px 0; color:#1a1a1a;">Widget Settings (Test)</h4>
                        <div class="settings-group" style="flex-direction:row; align-items:center;">
                            <input type="checkbox" id="stg-intent">
                            <label for="stg-intent" style="margin:0;">Enable Intent Discounts</label>
                        </div>
                        <div class="settings-group">
                            <label>Promo Code</label>
                            <input type="text" id="stg-promo">
                        </div>
                        <div class="settings-group">
                            <label>Discount Text</label>
                            <input type="text" id="stg-amount">
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
                            <input type="text" id="stg-custom">
                        </div>
                        <div class="settings-group" style="flex-direction:row; align-items:center;">
                            <input type="checkbox" id="stg-whitelabel">
                            <label for="stg-whitelabel" style="margin:0;">White Label (Hide branding)</label>
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

            const addMessage = (text, sender) => {
                const msg = document.createElement('div');
                msg.className = `message ${sender}`;
                msg.textContent = text;
                chatHistory.insertBefore(msg, loader);
                chatHistory.scrollTop = chatHistory.scrollHeight;
            };

            const handleAsk = (question) => {
                if (!question.trim() || isRequestPending) return;
                
                isRequestPending = true;
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
                let tonePrompt = "";
                if (cfg.tone === "friendly") tonePrompt = "Tone: Warm, welcoming, helpful, use 1-2 friendly emojis.";
                else if (cfg.tone === "professional") tonePrompt = "Tone: Concise, strictly professional, formal, no emojis.";
                else if (cfg.tone === "sales") tonePrompt = "Tone: Persuasive, highlight product benefits, actively guide towards purchase.";
                else if (cfg.tone === "custom") tonePrompt = "Tone: " + cfg.customTonePrompt;
                
                const intentRule = "ONLY append [INTENT: HIGH] if user asks about discounts, coupons, shipping costs, or checkout hesitation. Otherwise append [INTENT: LOW].";
                const sysInstr = tonePrompt + " " + intentRule;

                // Call our Vercel backend instead of direct Google API
                fetch('https://clarity-cart-widget.vercel.app/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        question,
                        productContext: extractedContext,
                        systemInstruction: sysInstr
                    })
                })
                .then(res => {
                    if (!res.ok) throw new Error('Network response was not ok');
                    return res.json();
                })
                .then(data => {
                    isRequestPending = false;
                    loader.classList.remove('active');
                    input.disabled = false;
                    sendBtn.disabled = false;
                    input.focus();
                    
                    let response = data.answer || "Sorry, I received an empty response.";
                    
                    const isHighIntent = response.includes('[INTENT: HIGH]');
                    response = response.replace(/\[INTENT: HIGH\]/g, '').replace(/\[INTENT: LOW\]/g, '').trim();
                    
                    addMessage(response, 'ai');

                    if (cfg.intentDiscountEnabled && isHighIntent && !sessionStorage.getItem('clarity_promo_seen')) {
                        sessionStorage.setItem('clarity_promo_seen', 'true');
                        shadow.getElementById('discount-code-val').textContent = cfg.promoCode;
                        shadow.getElementById('discount-amount-val').textContent = cfg.discountAmount;
                        shadow.getElementById('discount-banner').classList.add('active');
                    }

                    if (data.usedModel) {
                        console.log(`[ClarityCart] Response generated using: ${data.usedModel}`);
                    }
                })
                .catch(err => {
                    console.error('ClarityCart API Error:', err);
                    isRequestPending = false;
                    loader.classList.remove('active');
                    input.disabled = false;
                    sendBtn.disabled = false;
                    input.focus();
                    
                    addMessage("Произошла ошибка при соединении с сервером. Пожалуйста, попробуйте еще раз.", 'ai');
                });
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
            
            stgBtn.addEventListener('click', () => {
                stgModal.classList.toggle('active');
                const cfg = window.ClarityCartConfig;
                shadow.getElementById('stg-intent').checked = cfg.intentDiscountEnabled;
                shadow.getElementById('stg-promo').value = cfg.promoCode;
                shadow.getElementById('stg-amount').value = cfg.discountAmount;
                shadow.getElementById('stg-tone').value = cfg.tone;
                shadow.getElementById('stg-custom').value = cfg.customTonePrompt;
                shadow.getElementById('stg-whitelabel').checked = cfg.whiteLabel;
                stgCustomWrap.style.display = cfg.tone === 'custom' ? 'flex' : 'none';
            });
            
            stgTone.addEventListener('change', () => {
                stgCustomWrap.style.display = stgTone.value === 'custom' ? 'flex' : 'none';
            });
            
            stgSave.addEventListener('click', () => {
                window.ClarityCartConfig.intentDiscountEnabled = shadow.getElementById('stg-intent').checked;
                window.ClarityCartConfig.promoCode = shadow.getElementById('stg-promo').value;
                window.ClarityCartConfig.discountAmount = shadow.getElementById('stg-amount').value;
                window.ClarityCartConfig.tone = shadow.getElementById('stg-tone').value;
                window.ClarityCartConfig.customTonePrompt = shadow.getElementById('stg-custom').value;
                window.ClarityCartConfig.whiteLabel = shadow.getElementById('stg-whitelabel').checked;
                
                shadow.getElementById('clarity-footer').style.display = window.ClarityCartConfig.whiteLabel ? 'none' : 'block';
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
