(function (root) {
    'use strict';
    function mountBillingUI(options) {
        const { document, getSession, getStoreId, fetch: request, storage, navigate, randomUUID } = options;
        const mock = options.mock === true;
        let busy = false, state = null, opener;
        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-labelledby', 'billing-title');
        dialog.style.cssText = 'background:#111827;color:#f3f4f6;border:1px solid #475569;border-radius:20px;padding:28px;width:min(740px,92vw);max-height:90vh;overflow:auto';
        dialog.innerHTML = `<form method="dialog"><button aria-label="Close plans" style="float:right">×</button></form>
            <h2 id="billing-title">Choose your ClarityCart plan</h2>
            <p>Monthly billing. Checkout shows the final price before you confirm.</p>
            <p id="billing-message" role="status" aria-live="polite"></p>
            <div style="display:flex;flex-wrap:wrap;gap:16px">
            <section><h3>Starter</h3><p>500 AI responses / month</p><button data-plan="starter">Choose Starter</button></section>
            <section><h3>Pro</h3><p>2,500 AI responses / month</p><button data-plan="pro">Choose Pro</button></section>
            <section><h3>Business</h3><p>10,000 AI responses / month</p><button data-plan="business">Choose Business</button></section>
            </div><p>Access changes only after server confirmation from Paddle.</p>`;
        document.body.appendChild(dialog);
        const message = dialog.querySelector('#billing-message');
        const buttons = [...dialog.querySelectorAll('[data-plan]')];
        const say = text => { message.textContent = text; };
        const lock = value => { busy = value; buttons.forEach(button => { button.disabled = value; }); };
        async function api(action, body) {
            const session = await getSession();
            if (!session?.access_token) throw new Error('Please sign in again.');
            const store = getStoreId();
            if (!store) throw new Error('Create or select a store first.');
            const response = await request((options.base || '') + '/api/billing/' + action + (!body ? '?store_id=' + encodeURIComponent(store) : ''), {
                method: body ? 'POST' : 'GET',
                headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify({ ...body, store_id: store }) } : {}),
                signal: AbortSignal.timeout(20000)
            });
            const result = await response.json();
            if (!response.ok) {
                const known = {
                    CHECKOUT_PENDING_RECONCILIATION: 'Checkout is still being confirmed. Retry later; do not create another payment.',
                    CHECKOUT_ALREADY_OPEN: 'Another checkout is open. Choose its original plan to resume it.',
                    SUBSCRIPTION_ALREADY_EXISTS: 'An existing subscription must be managed before opening another checkout.'
                };
                const error = new Error(known[result.error] || (response.status === 503 ? 'Billing is not configured or temporarily unavailable. Your access has not changed.' : 'Billing request failed. Please retry or contact support.'));
                error.code = result.error;
                throw error;
            }
            return result;
        }
        async function open(trigger) {
            if (busy) return;
            opener = trigger; state = null;
            if (!dialog.open) dialog.showModal();
            if (mock) { say('LOCAL MOCK — no payment, trial or account changes will be made.'); return; }
            lock(true); say('Checking your billing status…');
            try {
                const store = getStoreId();
                state = await api('status');
                if (store !== getStoreId()) { state = null; throw new Error('Store changed. Reopen plans.'); }
                state.store_id = store;
                say(state.subscription && state.subscription.status !== 'canceled'
                    ? 'You already have a subscription. Plan changes are not enabled in this dialog yet.'
                    : state.trial_available ? 'Eligible for a 7-day free trial. A payment method is required; checkout shows renewal terms.' : 'Trial unavailable. Review the recurring price at checkout.');
            } catch (error) { say(error.message); }
            finally { lock(false); if (!state || (state.subscription && state.subscription.status !== 'canceled')) buttons.forEach(button => { button.disabled = true; }); }
        }
        async function select(plan) {
            if (busy) return;
            if (mock) { say('LOCAL MOCK: ' + plan + ' selected. No checkout was created and no access was granted.'); return; }
            if (!state || state.store_id !== getStoreId() || (state.subscription && state.subscription.status !== 'canceled')) return;
            lock(true); say('Preparing secure checkout…');
            const key = 'cc-checkout:' + getStoreId() + ':' + plan + ':month';
            try {
                let requestId = storage.getItem(key);
                if (!requestId) { requestId = randomUUID(); storage.setItem(key, requestId); }
                const result = await api('checkout', { request_id: requestId, plan, interval: 'month' });
                if (result.status === 'completed') { say('Checkout already completed. Refresh to load server-confirmed access.'); return; }
                const url = new URL(result.checkout_url);
                if (url.protocol !== 'https:' || url.username || url.password || !/^txn_[a-z0-9]{26}$/.test(result.transaction_id) || url.searchParams.get('_ptxn') !== result.transaction_id) throw new Error('Invalid checkout destination. Contact support.');
                navigate(url.href);
            } catch (error) {
                if (error.code === 'CHECKOUT_FAILED_USE_NEW_REQUEST') storage.removeItem(key);
                say(error.name === 'TimeoutError' ? 'Checkout timed out. Retry with the same request; do not start another payment.' : error.message);
            }
            finally { lock(false); }
        }
        buttons.forEach(button => button.addEventListener('click', () => select(button.dataset.plan)));
        dialog.addEventListener('close', () => opener?.focus());
        document.addEventListener('click', event => {
            const link = event.target.closest('a[href="index.html#pricing"]');
            if (link) { event.preventDefault(); open(link); }
        });
        return { open, select, dialog };
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { mountBillingUI };
    else root.mountBillingUI = mountBillingUI;
})(typeof window === 'undefined' ? globalThis : window);
